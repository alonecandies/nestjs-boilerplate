import { billingSchema, PaymentStatus, payments } from '@app/billing';
import { DomainValidationException, ExternalServiceException, generateId } from '@app/common';
import { type GrpcConfig, grpcConfig } from '@app/config';
import type { BillingServiceClient, PaymentList } from '@app/contracts';
import { DRIZZLE } from '@app/database';
import { REDIS_CLIENT } from '@app/redis';
import { InMemoryRedis } from '@app/redis/testing';
import {
  createGrpcClientOptions,
  FakeKafkaProducer,
  GrpcCircuitBreakers,
  grpcCall,
  KafkaProducer,
} from '@app/transport';
import { type ServiceError, status } from '@grpc/grpc-js';
import { ClientGrpcProxy } from '@nestjs/microservices';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { getTableColumns } from 'drizzle-orm';
import { lastValueFrom, type Observable } from 'rxjs';
import Stripe from 'stripe';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { createFakePostgres, type FakeRow } from './support/fake-postgres.js';
import { freePort } from './support/free-port.js';
import { startServiceTestApp } from './support/service-test-app.js';

/*
 * billing-service end to end, no Docker: the REAL AppModule (CQRS handlers, Drizzle repositories,
 * the transactional CLS plugin, StripeModule with real signature verification, observability,
 * common enhancers) with fakes only at the network edges — a drizzle instance over a fake
 * postgres.js client, an in-memory Redis and a recording Kafka producer. Stripe itself is never
 * called. gRPC is real: loopback server + gateway-style ClientGrpcProxy.
 */

const WEBHOOK_SECRET = 'whsec_billing_service_e2e';
const USER_ID = '01920000-0000-7000-8000-0000000000c1';
const BROKEN_DB_USER_ID = '01920000-0000-7000-8000-0000000000c2';
const PAID_ID = '01920000-0000-7000-8000-0000000000d2';
const PENDING_ID = '01920000-0000-7000-8000-0000000000d1';
const CREATED_AT = new Date('2026-09-01T10:00:00.123Z');
const PAID_AT = new Date('2026-09-01T10:05:00.000Z');

/** A `payments` row as postgres.js returns it (columns in declaration order, int8 as a string). */
function paymentRow(values: Record<string, unknown>): FakeRow {
  return Object.fromEntries(
    Object.keys(getTableColumns(payments)).map((column) => [column, values[column] ?? null]),
  );
}

const PAYMENT_ROWS = [
  paymentRow({
    id: PAID_ID,
    userId: USER_ID,
    priceId: 'price_pro',
    quantity: 2,
    amountTotal: '9007199254',
    currency: 'jpy',
    status: PaymentStatus.Succeeded,
    stripeCheckoutSessionId: 'cs_test_paid',
    stripePaymentIntentId: 'pi_test_paid',
    paidAt: PAID_AT.toISOString(),
    version: 1,
    createdAt: CREATED_AT.toISOString(),
    updatedAt: PAID_AT.toISOString(),
  }),
  // Not priced by Stripe yet: no amount, currency or session.
  paymentRow({
    id: PENDING_ID,
    userId: USER_ID,
    priceId: 'price_basic',
    quantity: 1,
    status: PaymentStatus.Pending,
    version: 0,
    createdAt: CREATED_AT.toISOString(),
    updatedAt: CREATED_AT.toISOString(),
  }),
];

const processedEvents = new Set<string>();
const postgres = createFakePostgres(billingSchema, (sql, params) => {
  if (sql === 'select 1') return [{ '?column?': 1 }];
  if (sql.startsWith('insert into "stripe_events"')) {
    const [eventId] = params as [string];
    if (processedEvents.has(eventId)) return []; // ON CONFLICT DO NOTHING
    processedEvents.add(eventId);
    return [{ id: eventId }];
  }
  if (sql.includes('from "payments" where "payments"."user_id"')) {
    if (params[0] === BROKEN_DB_USER_ID) {
      throw new Error('connection terminated unexpectedly (db 10.0.0.12:5432)');
    }
    return params[0] === USER_ID ? PAYMENT_ROWS : [];
  }
  return [];
});

/** A webhook exactly as Stripe sends it: raw JSON bytes + `Stripe-Signature` over them. */
function signedWebhook(type: string, id = `evt_${generateId().replaceAll('-', '')}`) {
  const json = JSON.stringify({
    id,
    object: 'event',
    type,
    api_version: Stripe.API_VERSION,
    created: Math.floor(Date.now() / 1_000),
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    data: { object: { id: 'cus_test_1', object: 'customer' } },
  });
  return {
    id,
    payload: Buffer.from(json),
    signature: Stripe.webhooks.generateTestHeaderString({ payload: json, secret: WEBHOOK_SECRET }),
  };
}

describe('billing-service (real AppModule, fakes at the network edges)', () => {
  let app: NestFastifyApplication;
  let client: ClientGrpcProxy;
  let billing: BillingServiceClient;
  const breakers = new GrpcCircuitBreakers();

  /** What the gateway adapter does: deadline + breaker + ServiceError → DomainException. */
  const call = <T>(source: Observable<T>, operation: string): Promise<T> =>
    grpcCall(source, { timeoutMs: 3_000, operation, breaker: breakers.get('billing') });

  beforeAll(async () => {
    const grpcUrl = `127.0.0.1:${await freePort()}`;
    const env: Record<string, string> = {
      LOG_LEVEL: 'silent',
      SERVICE_NAME: 'billing-service',
      GRPC_URL: grpcUrl,
      BILLING_GRPC_URL: grpcUrl,
      GRPC_DEADLINE_MS: '3000',
      STRIPE_SECRET_KEY: 'sk_test_billing_service_e2e',
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      // Nothing may reach real infrastructure: unreachable ports wherever a client could connect.
      DATABASE_URL: 'postgres://app:app@127.0.0.1:1/app',
      REDIS_URL: 'redis://127.0.0.1:1',
      KAFKA_BROKERS: '127.0.0.1:1',
    };
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);

    const builder = Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DRIZZLE)
      .useValue(postgres.db)
      .overrideProvider(REDIS_CLIENT)
      .useValue(new InMemoryRedis().asRedis())
      .overrideProvider(KafkaProducer)
      .useValue(new FakeKafkaProducer({ source: 'billing-service' }));
    app = await startServiceTestApp(builder, { grpc: ['billing'] });

    client = new ClientGrpcProxy(createGrpcClientOptions(grpcConfig.parse(), 'billing').options);
    billing = client.getService<BillingServiceClient>('BillingService');
  }, 60_000);

  afterAll(async () => {
    breakers.onApplicationShutdown();
    client?.close();
    await app?.close();
    vi.unstubAllEnvs();
    // The Postgres pool is released by DatabaseModule's shutdown hook.
    expect(postgres.end).toHaveBeenCalled();
  }, 30_000);

  describe('HTTP (ops only)', () => {
    it('GET /health/live → 200 without touching any dependency', async () => {
      const response = await app.inject({ method: 'GET', url: '/health/live' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: 'ok' });
    });

    it('GET /metrics → Prometheus text (Node default metrics + HTTP latency histogram)', async () => {
      const response = await app.inject({ method: 'GET', url: '/metrics' });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/plain');
      expect(response.body).toContain('process_cpu_user_seconds_total');
      expect(response.body).toContain('# TYPE http_request_duration_seconds histogram');
    });

    it('GET /health/ready → 200 on postgres + redis alone: an unreachable Kafka never un-readies the service', async () => {
      // KAFKA_BROKERS points at a closed port: event publishing is best-effort, so checkout and
      // webhooks must stay in rotation during a broker outage.
      const response = await app.inject({ method: 'GET', url: '/health/ready' });
      const body = response.json<{ status: string; info: object; error: object }>();
      expect(response.statusCode).toBe(200);
      expect(body.status).toBe('ok');
      expect(Object.keys({ ...body.info, ...body.error }).sort()).toEqual(['postgres', 'redis']);
      expect(body.info).toMatchObject({ postgres: { status: 'up' }, redis: { status: 'up' } });
      expect(body.error).toEqual({});
    });

    it('no webhook route here: the gateway receives Stripe and forwards over gRPC', async () => {
      const response = await app.inject({ method: 'POST', url: '/v1/billing/webhooks/stripe' });
      expect(response.statusCode).toBe(404);
      expect(response.headers['content-type']).toContain('application/problem+json');
    });
  });

  describe('gRPC billing.v1', () => {
    it('the gRPC namespace resolves from the app container (connectGrpcServer never falls back)', () => {
      // On a NestFactory app a missed `app.get` is logged at ERROR by Nest's exception proxy
      // before transport falls back to parsing the env, so AppModule loads the namespace itself.
      expect(app.get<GrpcConfig, GrpcConfig>(grpcConfig.KEY, { strict: false }).url).toMatch(
        /^127\.0\.0\.1:\d+$/,
      );
    });

    it('ListPayments runs the real query handler + repository; int64 → string, Timestamp → Date', async () => {
      const list: PaymentList = await call(
        billing.listPayments({ userId: USER_ID, limit: 5 }),
        'BillingService.ListPayments',
      );

      const [paid, pending] = list.items;
      expect(paid).toMatchObject({
        id: PAID_ID,
        userId: USER_ID,
        status: 'succeeded',
        amountTotal: '9007199254',
        currency: 'jpy',
        priceId: 'price_pro',
        quantity: 2,
        stripeCheckoutSessionId: 'cs_test_paid',
        createdAt: CREATED_AT,
        updatedAt: PAID_AT,
      });
      expect(paid?.createdAt).toBeInstanceOf(Date);
      expect(pending).toMatchObject({ id: PENDING_ID, status: 'pending', amountTotal: '0' });
      // LIMIT = page size + 1 look-ahead row; both rows fit, so this is the last page.
      expect(postgres.executed.at(-1)).toMatchObject({ params: [USER_ID, 6] });
      expect(list.nextCursor).toBeUndefined();
    });

    it('ListPayments pages with a keyset cursor (next_cursor out, cursor in → id < $cursor)', async () => {
      const first: PaymentList = await call(
        billing.listPayments({ userId: USER_ID, limit: 1 }),
        'BillingService.ListPayments',
      );
      expect(first.items.map((p) => p.id)).toEqual([PAID_ID]);
      expect(first.nextCursor).toEqual(expect.any(String));

      const second: PaymentList = await call(
        billing.listPayments({ userId: USER_ID, limit: 1, cursor: first.nextCursor }),
        'BillingService.ListPayments',
      );
      // The fake answers only the first-page statement: the resumed query is a different one.
      expect(second.items).toEqual([]);
      const resumed = postgres.executed.at(-1);
      expect(resumed?.sql).toContain('"payments"."id" < $2');
      expect(resumed?.params).toEqual([USER_ID, PAID_ID, 2]);
    });

    it('ListPayments with a malformed user id → INVALID_ARGUMENT before any SQL', async () => {
      const before = postgres.executed.length;
      const raw = await lastValueFrom(billing.listPayments({ userId: 'nope', limit: 5 })).catch(
        (e: unknown) => e,
      );
      expect(raw).toMatchObject({ code: status.INVALID_ARGUMENT });

      const error = await call(
        billing.listPayments({ userId: 'nope', limit: 5 }),
        'BillingService.ListPayments',
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DomainValidationException);
      expect((error as DomainValidationException).issues).toEqual([
        expect.objectContaining({ path: 'userId' }),
      ]);
      expect(postgres.executed).toHaveLength(before);
    });

    it('a database failure → INTERNAL without leaking internals; the caller sees a 502', async () => {
      const request = { userId: BROKEN_DB_USER_ID, limit: 5 };
      const raw = await lastValueFrom(billing.listPayments(request)).catch((e: unknown) => e);
      expect(raw).toMatchObject({ code: status.INTERNAL });
      expect((raw as ServiceError).details).not.toContain('10.0.0.12');

      const error = await call(billing.listPayments(request), 'BillingService.ListPayments').catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ExternalServiceException);
      expect((error as Error).message).not.toContain('10.0.0.12');
    });

    it('HandleStripeWebhook verifies the signature over the raw bytes and applies an event once', async () => {
      const before = postgres.executed.length;
      const webhook = signedWebhook('customer.created');
      const request = { payload: webhook.payload, signature: webhook.signature };

      await expect(
        call(billing.handleStripeWebhook(request), 'BillingService.HandleStripeWebhook'),
      ).resolves.toEqual({
        received: true,
        eventId: webhook.id,
        eventType: 'customer.created',
        duplicate: false,
      });
      // Stripe retries deliveries: the second one is acknowledged as a duplicate.
      await expect(
        call(billing.handleStripeWebhook(request), 'BillingService.HandleStripeWebhook'),
      ).resolves.toMatchObject({ eventId: webhook.id, duplicate: true });

      expect(postgres.executed.slice(before).map((query) => query.sql)).toEqual([
        'BEGIN',
        expect.stringContaining('insert into "stripe_events"'),
        'COMMIT',
        'BEGIN',
        expect.stringContaining('insert into "stripe_events"'),
        'COMMIT',
      ]);
    });

    it('HandleStripeWebhook with a forged signature → INVALID_ARGUMENT / INVALID_WEBHOOK_SIGNATURE, no SQL', async () => {
      const before = postgres.executed.length;
      const webhook = signedWebhook('checkout.session.completed');
      const request = { payload: webhook.payload, signature: 't=1,v1=forged' };

      const raw = await lastValueFrom(billing.handleStripeWebhook(request)).catch(
        (e: unknown) => e,
      );
      expect(raw).toMatchObject({ code: status.INVALID_ARGUMENT });
      expect((raw as ServiceError).metadata.get('x-error-code')).toEqual([
        'INVALID_WEBHOOK_SIGNATURE',
      ]);
      expect(postgres.executed).toHaveLength(before);
    });
  });
});

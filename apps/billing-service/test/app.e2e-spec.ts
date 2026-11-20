import {
  billingSchema,
  ImmudbLedgerAdapter,
  LedgerPort,
  LedgerPostingConsumer,
  PaymentStatus,
  payments,
  StripeEventsSystemRepository,
} from '@domain/billing';
import { InMemoryStripeEventsSystemRepository } from '@domain/billing/testing';
import {
  BILLING_GRPC_PACKAGE,
  type BillingServiceClient,
  LEDGER_POSTING_REQUESTED_EVENT,
  type PaymentList,
} from '@domain/billing-contracts';
import { Metadata, type ServiceError, status } from '@grpc/grpc-js';
import { Logger } from '@nestjs/common';
import { ClientGrpcProxy } from '@nestjs/microservices';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import {
  DomainValidationException,
  ExternalServiceException,
  generateId,
  PLATFORM_TENANT_ID,
} from '@platform/common';
import { type GrpcConfig, grpcConfig } from '@platform/config';
import { DRIZZLE } from '@platform/database';
import { ImmudbClient } from '@platform/immudb';
import { RecordingImmudbClient } from '@platform/immudb/testing';
import { MetricsListener } from '@platform/observability';
import { OutboxRelay, outboxRelayLockResource, outboxRelayToken } from '@platform/outbox';
import { DistributedLockService, REDIS_CLIENT } from '@platform/redis';
import { InMemoryRedis } from '@platform/redis/testing';
import {
  createGrpcClientOptions,
  createOutgoingMetadata,
  GrpcCircuitBreakers,
  grpcCall,
  KafkaProducer,
} from '@platform/transport';
import { FakeKafkaProducer } from '@platform/transport/testing';
import { getTableColumns } from 'drizzle-orm';
import { lastValueFrom, type Observable } from 'rxjs';
import Stripe from 'stripe';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule, createAppModule } from '../src/app.module.js';
import { createFakePostgres, type ExecutedQuery, type FakeRow } from './support/fake-postgres.js';
import { freePort } from './support/free-port.js';
import { RecordingKafkaServer } from './support/recording-kafka.server.js';
import { startServiceTestApp } from './support/service-test-app.js';

/*
 * billing-service end to end, no Docker: the REAL AppModule (CQRS handlers, Drizzle repositories,
 * the transactional CLS plugin, StripeModule with real signature verification, observability,
 * common enhancers) with fakes only at the network edges — a drizzle instance over a fake
 * postgres.js client, an in-memory system repository (no app_system pool), an in-memory Redis and
 * a recording Kafka producer. Stripe itself is never called. gRPC is real: loopback server +
 * gateway-style ClientGrpcProxy. Every repository call is a unit of work: BEGIN, the caller's RLS
 * context (`SET LOCAL …`), the statement, COMMIT.
 */

const WEBHOOK_SECRET = 'whsec_billing_service_e2e';
const TENANT_ID = '01920000-0000-7000-8000-0000000000e1';
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
    tenantId: TENANT_ID,
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
    tenantId: TENANT_ID,
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
  if (sql.startsWith('insert into "billing"."stripe_events"')) {
    const [tenantId, eventId] = params as [string, string];
    const key = `${tenantId}:${eventId}`;
    if (processedEvents.has(key)) return []; // ON CONFLICT DO NOTHING
    processedEvents.add(key);
    return [{ id: eventId }];
  }
  if (
    sql.includes(
      'from "billing"."payments" where ("billing"."payments"."tenant_id" = $1 and "billing"."payments"."user_id" = $2) order by',
    )
  ) {
    if (params[1] === BROKEN_DB_USER_ID) {
      throw new Error('connection terminated unexpectedly (db 10.0.0.12:5432)');
    }
    return params[0] === TENANT_ID && params[1] === USER_ID ? PAYMENT_ROWS : [];
  }
  return [];
});

/** The last statement a repository sent (not BEGIN / COMMIT / the RLS context). */
const lastStatement = (): ExecutedQuery | undefined =>
  postgres.executed.findLast(
    ({ sql }) =>
      sql !== 'BEGIN' && sql !== 'COMMIT' && sql !== 'ROLLBACK' && !sql.startsWith('SET LOCAL'),
  );

/** The service's environment: nothing may reach real infrastructure (unreachable ports everywhere). */
function serviceEnv(grpcUrl: string): Record<string, string> {
  return {
    LOG_LEVEL: 'silent',
    SERVICE_NAME: 'billing-service',
    GRPC_URL: grpcUrl,
    GRPC_DEADLINE_MS: '3000',
    STRIPE_SECRET_KEY: 'sk_test_billing_service_e2e',
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    DATABASE_URL: 'postgres://app:app@127.0.0.1:1/app',
    REDIS_URL: 'redis://127.0.0.1:1',
    KAFKA_BROKERS: '127.0.0.1:1',
    // The relay resolves but stays off: no broker, and the case below pins that it never leads.
    OUTBOX_RELAY_ENABLED: 'false',
  };
}

/** The fakes at the network edges (Postgres, Redis, Kafka producer, the app_system Stripe events). */
function withEdgeFakes(
  builder: TestingModuleBuilder,
  systemEvents: InMemoryStripeEventsSystemRepository,
): TestingModuleBuilder {
  return builder
    .overrideProvider(DRIZZLE)
    .useValue(postgres.db)
    .overrideProvider(REDIS_CLIENT)
    .useValue(new InMemoryRedis().asRedis())
    .overrideProvider(KafkaProducer)
    .useValue(new FakeKafkaProducer({ source: 'billing-service' }))
    .overrideProvider(StripeEventsSystemRepository)
    .useValue(systemEvents);
}

/** A webhook exactly as Stripe sends it: raw JSON bytes + `Stripe-Signature` over them. */
function signedWebhook(
  type: string,
  id = `evt_${generateId().replaceAll('-', '')}`,
  object: Record<string, unknown> = { id: 'cus_test_1', object: 'customer' },
) {
  const json = JSON.stringify({
    id,
    object: 'event',
    type,
    api_version: Stripe.API_VERSION,
    created: Math.floor(Date.now() / 1_000),
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    data: { object },
  });
  return {
    id,
    payload: Buffer.from(json),
    signature: Stripe.webhooks.generateTestHeaderString({ payload: json, secret: WEBHOOK_SECRET }),
  };
}

/** A paid charge of the owner `TENANT_ID`/`USER_ID`: what Stripe signs for a money event (L-11). */
const chargeSucceeded = () =>
  signedWebhook('charge.succeeded', undefined, {
    id: 'ch_e2e_posting',
    object: 'charge',
    amount: 2_500,
    currency: 'usd',
    metadata: { tenantId: TENANT_ID, userId: USER_ID },
  });

/** The `billing.outbox` INSERTs the runtime pool executed (the posting records of the webhook). */
const outboxInserts = (): ExecutedQuery[] =>
  postgres.executed.filter(({ sql }) => sql.startsWith('insert into "billing"."outbox"'));

describe('billing-service (real AppModule, fakes at the network edges)', () => {
  let app: NestFastifyApplication;
  let client: ClientGrpcProxy;
  let billing: BillingServiceClient;
  /** What the outbox relay did while the app booted (its start decision runs on bootstrap). */
  const relayBoot = { lockResources: [] as unknown[], logLines: [] as unknown[][] };
  const breakers = new GrpcCircuitBreakers();
  /** The app_system side of the Stripe events ledger: platform webhooks land here, not in SQL. */
  const systemEvents = new InMemoryStripeEventsSystemRepository();
  /** What main.ts's consumer wiring passed to `connectKafkaConsumer` (nothing by default). */
  const kafkaConsumers: unknown[] = [];

  /** The caller metadata the gateway adapter derives from its CLS principal (B2-23). */
  const callerOf = (userId: string, tenantId = TENANT_ID) =>
    createOutgoingMetadata({ userId, tenantId, roles: ['member'] });

  /** What the gateway adapter does: deadline + breaker + ServiceError → DomainException. */
  const call = <T>(source: Observable<T>, operation: string): Promise<T> =>
    grpcCall(source, { timeoutMs: 3_000, operation, breaker: breakers.get('billing') });

  beforeAll(async () => {
    const grpcUrl = `127.0.0.1:${await freePort()}`;
    // The default LEDGER_ENABLED (false): no immudb, no Kafka consumer.
    for (const [name, value] of Object.entries(serviceEnv(grpcUrl))) vi.stubEnv(name, value);
    // Installed before the app boots: the relay decides whether to start on bootstrap.
    const lockAttempts = vi.spyOn(DistributedLockService.prototype, 'using');
    const logLines = vi.spyOn(Logger.prototype, 'log');

    const builder = withEdgeFakes(Test.createTestingModule({ imports: [AppModule] }), systemEvents);
    app = await startServiceTestApp(builder, {
      grpc: [BILLING_GRPC_PACKAGE],
      onKafkaConsumer: (options) => kafkaConsumers.push(options),
    });
    // Kept here: the config restores every spy before each test (restoreMocks).
    relayBoot.lockResources = lockAttempts.mock.calls.map(([resource]) => resource);
    relayBoot.logLines = logLines.mock.calls.filter(
      (_, call) =>
        (logLines.mock.contexts[call] as { context?: string } | undefined)?.context ===
        'OutboxRelay:billing',
    );
    lockAttempts.mockRestore();
    logLines.mockRestore();

    client = new ClientGrpcProxy(
      createGrpcClientOptions(grpcConfig.parse(), { spec: BILLING_GRPC_PACKAGE, url: grpcUrl })
        .options,
    );
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

    it('GET /metrics is not served on the HTTP port (METRICS_PORT has its own listener)', async () => {
      expect((await app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(404);
    });

    it('the metrics listener answers with Node default metrics and the HTTP latency histogram', async () => {
      await app.inject({ method: 'GET', url: '/health/live' });
      const scrape = await app.get(MetricsListener, { strict: false }).scrape();
      expect(scrape.status).toBe(200);
      expect(scrape.contentType).toMatch(/^text\/plain/);
      expect(scrape.body).toContain('process_cpu_user_seconds_total');
      expect(scrape.body).toContain('# TYPE http_request_duration_seconds histogram');
    });

    it('GET /health/ready → 200 on postgres + redis alone (no immudb): an unreachable Kafka never un-readies the service', async () => {
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

  describe('ledger off (the default LEDGER_ENABLED=false)', () => {
    it('loads no immudb client and no ledger-posting consumer', () => {
      expect(() => app.get(ImmudbClient, { strict: false })).toThrow();
      expect(() => app.get(LedgerPostingConsumer, { strict: false })).toThrow();
    });

    it('connects no Kafka consumer: gRPC is the only transport', () => {
      expect(kafkaConsumers).toEqual([]);
      expect(app.getMicroservices()).toHaveLength(1);
    });
  });

  describe('outbox relay (billing.outbox)', () => {
    it('resolves, and with OUTBOX_RELAY_ENABLED=false never asks for its lock', () => {
      expect(app.get(outboxRelayToken('billing'), { strict: false })).toBeInstanceOf(OutboxRelay);
      // It stopped at the switch, not at a missing system pool or a lost lock race.
      expect(relayBoot.logLines).toEqual([['relay disabled (OUTBOX_RELAY_ENABLED=false)']]);
      expect(relayBoot.lockResources).not.toContain(outboxRelayLockResource('billing'));
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
      const before = postgres.executed.length;
      const list: PaymentList = await call(
        billing.listPayments({ tenantId: TENANT_ID, userId: USER_ID, limit: 5 }, callerOf(USER_ID)),
        'BillingService.ListPayments',
      );

      const [paid, pending] = list.items;
      expect(paid).toMatchObject({
        id: PAID_ID,
        tenantId: TENANT_ID,
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
      expect(lastStatement()).toMatchObject({ params: [TENANT_ID, USER_ID, 6] });
      expect(list.nextCursor).toBeUndefined();
      // One unit of work, opened as the caller (the principal from the gRPC metadata).
      expect(postgres.executed.slice(before).map((query) => query.sql)).toEqual([
        'BEGIN',
        `SET LOCAL app.user_id = '${USER_ID}'; SET LOCAL app.tenant_id = '${TENANT_ID}'; SET LOCAL app.elevated = 'off'`,
        expect.stringContaining('from "billing"."payments" where'),
        'COMMIT',
      ]);
    });

    it('ListPayments pages with a keyset cursor (next_cursor out, cursor in → id < $cursor)', async () => {
      const first: PaymentList = await call(
        billing.listPayments({ tenantId: TENANT_ID, userId: USER_ID, limit: 1 }, callerOf(USER_ID)),
        'BillingService.ListPayments',
      );
      expect(first.items.map((p) => p.id)).toEqual([PAID_ID]);
      expect(first.nextCursor).toEqual(expect.any(String));

      const second: PaymentList = await call(
        billing.listPayments(
          { tenantId: TENANT_ID, userId: USER_ID, limit: 1, cursor: first.nextCursor },
          callerOf(USER_ID),
        ),
        'BillingService.ListPayments',
      );
      // The fake answers only the first-page statement: the resumed query is a different one.
      expect(second.items).toEqual([]);
      const resumed = lastStatement();
      expect(resumed?.sql).toContain('"billing"."payments"."id" < $3');
      expect(resumed?.params).toEqual([TENANT_ID, USER_ID, PAID_ID, 2]);
    });

    it('ListPayments with a malformed user id → INVALID_ARGUMENT before any SQL', async () => {
      const before = postgres.executed.length;
      const raw = await lastValueFrom(
        billing.listPayments({ tenantId: TENANT_ID, userId: 'nope', limit: 5 }),
      ).catch((e: unknown) => e);
      expect(raw).toMatchObject({ code: status.INVALID_ARGUMENT });

      const error = await call(
        billing.listPayments({ tenantId: TENANT_ID, userId: 'nope', limit: 5 }),
        'BillingService.ListPayments',
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DomainValidationException);
      expect((error as DomainValidationException).issues).toEqual([
        expect.objectContaining({ path: 'userId' }),
      ]);
      expect(postgres.executed).toHaveLength(before);
    });

    it('a database failure → INTERNAL without leaking internals; the caller sees a 502', async () => {
      const request = { tenantId: TENANT_ID, userId: BROKEN_DB_USER_ID, limit: 5 };
      const caller = callerOf(BROKEN_DB_USER_ID);
      const raw = await lastValueFrom(billing.listPayments(request, caller)).catch(
        (e: unknown) => e,
      );
      expect(raw).toMatchObject({ code: status.INTERNAL });
      expect((raw as ServiceError).details).not.toContain('10.0.0.12');

      const error = await call(
        billing.listPayments(request, caller),
        'BillingService.ListPayments',
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ExternalServiceException);
      expect((error as Error).message).not.toContain('10.0.0.12');
    });

    it('UNAUTHENTICATED PRINCIPAL_MISSING for ListPayments without a caller', async () => {
      const raw = await lastValueFrom(
        billing.listPayments({ tenantId: TENANT_ID, userId: USER_ID, limit: 5 }, new Metadata()),
      ).catch((e: unknown) => e);
      expect(raw).toMatchObject({ code: status.UNAUTHENTICATED });
    });

    it('PERMISSION_DENIED TENANT_MISMATCH when the request tenant is not the caller tenant', async () => {
      const raw = await lastValueFrom(
        billing.listPayments(
          { tenantId: TENANT_ID, userId: USER_ID, limit: 5 },
          callerOf(USER_ID, generateId()),
        ),
      ).catch((e: unknown) => e);
      expect(raw).toMatchObject({ code: status.PERMISSION_DENIED });
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

      // A customer event carries no owner: a platform event, recorded once through the system
      // method (B3 Task 16); no runtime transaction, so no SQL on the app_runtime pool.
      expect(systemEvents.events.filter((event) => event.id === webhook.id)).toEqual([
        expect.objectContaining({
          tenantId: PLATFORM_TENANT_ID,
          userId: null,
          type: 'customer.created',
        }),
      ]);
      expect(postgres.executed).toHaveLength(before);
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

    it('HandleStripeWebhook with a paid charge and LEDGER_ENABLED=false records the receipt and leaves no posting record', async () => {
      const before = postgres.executed.length;
      const webhook = chargeSucceeded();

      await expect(
        call(
          billing.handleStripeWebhook({ payload: webhook.payload, signature: webhook.signature }),
          'BillingService.HandleStripeWebhook',
        ),
      ).resolves.toEqual({
        received: true,
        eventId: webhook.id,
        eventType: 'charge.succeeded',
        duplicate: false,
      });

      // The receipt was written in the owner's unit of work; no billing.ledger-posting.v1 row.
      const sent = postgres.executed.slice(before).map((query) => query.sql);
      expect(sent).toContainEqual(expect.stringContaining('insert into "billing"."stripe_events"'));
      expect(sent.some((sql) => sql.includes('"billing"."outbox"'))).toBe(false);
    });
  });
});

describe('billing-service with LEDGER_ENABLED=true (immudb, the ledger-posting consumer)', () => {
  let app: NestFastifyApplication;
  let client: ClientGrpcProxy;
  let billing: BillingServiceClient;
  const kafka = new RecordingKafkaServer();
  const kafkaConsumers: unknown[] = [];
  const immudb = new RecordingImmudbClient();

  beforeAll(async () => {
    const grpcUrl = `127.0.0.1:${await freePort()}`;
    const env = {
      ...serviceEnv(grpcUrl),
      LEDGER_ENABLED: 'true',
      // The session pool behind the readiness check: nothing listens there.
      IMMUDB_ADDRESS: '127.0.0.1:1',
    };
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    // Defined now, after the env: the module reads LEDGER_ENABLED when it is defined.
    const builder = withEdgeFakes(
      Test.createTestingModule({ imports: [createAppModule()] }),
      new InMemoryStripeEventsSystemRepository(),
    )
      .overrideProvider(ImmudbClient)
      .useValue(immudb);
    app = await startServiceTestApp(builder, {
      grpc: [BILLING_GRPC_PACKAGE],
      kafka,
      onKafkaConsumer: (options) => kafkaConsumers.push(options),
    });
    client = new ClientGrpcProxy(
      createGrpcClientOptions(grpcConfig.parse(), { spec: BILLING_GRPC_PACKAGE, url: grpcUrl })
        .options,
    );
    billing = client.getService<BillingServiceClient>('BillingService');
  }, 60_000);

  afterAll(async () => {
    client?.close();
    await app?.close();
    vi.unstubAllEnvs();
  }, 30_000);

  it('connects one Kafka consumer, in group billing-service, carrying the ledger-posting handler', () => {
    expect(kafkaConsumers).toEqual([{ groupId: 'billing-service' }]);
    expect(app.getMicroservices()).toHaveLength(2);
    expect(kafka.patterns()).toEqual([LEDGER_POSTING_REQUESTED_EVENT.topic]);
    expect(app.get(LedgerPostingConsumer, { strict: false })).toBeInstanceOf(LedgerPostingConsumer);
  });

  it('binds LedgerPort to the immudb adapter over the global ImmudbClient', () => {
    expect(app.get(ImmudbClient, { strict: false })).toBe(immudb);
    expect(app.get(LedgerPort, { strict: false })).toBeInstanceOf(ImmudbLedgerAdapter);
  });

  it('GET /health/ready reports immudb: unreachable, it takes the service out of rotation', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    const body = response.json<{ status: string; info: object; error: object }>();
    expect(Object.keys({ ...body.info, ...body.error }).sort()).toEqual([
      'immudb',
      'postgres',
      'redis',
    ]);
    expect(response.statusCode).toBe(503);
    expect(body.error).toMatchObject({ immudb: { status: 'down' } });
    expect(body.info).toMatchObject({ postgres: { status: 'up' }, redis: { status: 'up' } });
  });

  it('HandleStripeWebhook with a paid charge leaves one billing.ledger-posting.v1 record in the unit of work of its receipt', async () => {
    const before = postgres.executed.length;
    const webhook = chargeSucceeded();

    await expect(
      lastValueFrom(
        billing.handleStripeWebhook({ payload: webhook.payload, signature: webhook.signature }),
      ),
    ).resolves.toMatchObject({
      eventId: webhook.id,
      eventType: 'charge.succeeded',
      duplicate: false,
    });

    // BEGIN, RLS context, receipt, posting record, COMMIT: nothing reaches Kafka from the request.
    const sent = postgres.executed.slice(before);
    const insert = outboxInserts().filter((query) => postgres.executed.indexOf(query) >= before);
    expect(insert).toHaveLength(1);
    expect(insert[0]?.params).toEqual(
      expect.arrayContaining([TENANT_ID, LEDGER_POSTING_REQUESTED_EVENT.topic]),
    );
    const sqls = sent.map((query) => query.sql);
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls.at(-1)).toBe('COMMIT');
    const receipt = sqls.findIndex((sql) => sql.includes('"billing"."stripe_events"'));
    const posting = sqls.findIndex((sql) => sql.includes('"billing"."outbox"'));
    expect(receipt).toBeGreaterThan(0);
    expect(posting).toBeGreaterThan(receipt);
  });
});

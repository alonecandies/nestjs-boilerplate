import {
  billingSchema,
  PaymentStatus,
  payments,
  StripeEventsSystemRepository,
} from '@domain/billing';
import { InMemoryStripeEventsSystemRepository } from '@domain/billing/testing';
import {
  BILLING_GRPC_PACKAGE,
  type BillingServiceClient,
  type PaymentList,
} from '@domain/billing-contracts';
import { type Metadata, type ServiceError, status } from '@grpc/grpc-js';
import { ClientGrpcProxy } from '@nestjs/microservices';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { generateId, PLATFORM_TENANT_ID } from '@platform/common';
import { grpcConfig } from '@platform/config';
import { DRIZZLE } from '@platform/database';
import { REDIS_CLIENT } from '@platform/redis';
import { InMemoryRedis } from '@platform/redis/testing';
import {
  createGrpcClientOptions,
  createOutgoingMetadata,
  GRPC_METADATA_KEYS,
  KafkaProducer,
} from '@platform/transport';
import {
  createTestPrincipalSigner,
  FakeKafkaProducer,
  withBoundGrpcPort,
} from '@platform/transport/testing';
import { getTableColumns } from 'drizzle-orm';
import { lastValueFrom, type Observable } from 'rxjs';
import Stripe from 'stripe';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { createFakePostgres, type FakeRow } from './support/fake-postgres.js';
import { startServiceTestApp } from './support/service-test-app.js';

/*
 * billing-service under GRPC_PRINCIPAL_ASSERTION=enforce (B2-12): the REAL AppModule, configured
 * from the environment like a deployed service (public key only, no signing key), with fakes at
 * the network edges as in app.e2e-spec.ts. The roles travel and billing recomputes the permissions
 * from them, so a mesh peer without the edge's private key cannot claim `admin` (billing:read-all)
 * to list a whole tenant; Stripe's webhook, anonymous and signed by Stripe, still passes. The other
 * e2e specs keep the default `off`.
 */

const WEBHOOK_SECRET = 'whsec_billing_service_enforce_e2e';
const TENANT_ID = '01920000-0000-7000-8000-0000000000e1';
const ADMIN_ID = '01920000-0000-7000-8000-0000000000c9';
const MEMBER_ID = '01920000-0000-7000-8000-0000000000c1';
const PAYMENT_ID = '01920000-0000-7000-8000-0000000000d2';
const CREATED_AT = '2026-09-01T10:00:00.123Z';

/** A member's payment, as postgres.js returns the `payments` row (columns in declaration order). */
function paymentRow(): FakeRow {
  const values: Record<string, unknown> = {
    tenantId: TENANT_ID,
    id: PAYMENT_ID,
    userId: MEMBER_ID,
    priceId: 'price_pro',
    quantity: 1,
    amountTotal: '2500',
    currency: 'usd',
    status: PaymentStatus.Succeeded,
    version: 1,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
  return Object.fromEntries(
    Object.keys(getTableColumns(payments)).map((column) => [column, values[column] ?? null]),
  );
}

// The whole-tenant listing (no user filter) answers the member's payment for TENANT_ID.
const postgres = createFakePostgres(billingSchema, (sql, params) => {
  if (sql === 'select 1') return [{ '?column?': 1 }];
  if (sql.startsWith('select') && sql.includes('from "billing"."payments"')) {
    return params[0] === TENANT_ID ? [paymentRow()] : [];
  }
  return [];
});

/** A webhook exactly as Stripe sends it: raw JSON bytes + `Stripe-Signature` over them. */
function signedWebhook(type: string) {
  const id = `evt_${generateId().replaceAll('-', '')}`;
  const json = JSON.stringify({
    id,
    object: 'event',
    type,
    api_version: Stripe.API_VERSION,
    created: Math.floor(Date.now() / 1_000),
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    data: { object: { id: 'cus_test_enforce', object: 'customer' } },
  });
  return {
    id,
    payload: Buffer.from(json),
    signature: Stripe.webhooks.generateTestHeaderString({ payload: json, secret: WEBHOOK_SECRET }),
  };
}

describe('billing-service with GRPC_PRINCIPAL_ASSERTION=enforce', () => {
  let app: NestFastifyApplication;
  let client: ClientGrpcProxy;
  let billing: BillingServiceClient;
  const signer = createTestPrincipalSigner('edge-e2e');
  /** The app_system side of the Stripe events ledger: a platform webhook lands here. */
  const systemEvents = new InMemoryStripeEventsSystemRepository();
  /** A tenant admin: the role grants billing:read-all, what a hostile mesh peer would assert. */
  const admin = { userId: ADMIN_ID, tenantId: TENANT_ID, roles: ['admin'] };
  /** Every payment of the tenant: no user filter, so it needs billing:read-all. */
  const listTenant = (metadata: Metadata): Observable<PaymentList> =>
    billing.listPayments({ tenantId: TENANT_ID, limit: 5 }, metadata);
  const failureOf = (source: Observable<unknown>): Promise<ServiceError> =>
    lastValueFrom(source).then(
      () => {
        throw new Error('expected the call to fail');
      },
      (error: unknown) => error as ServiceError,
    );
  const errorCode = (error: ServiceError): unknown =>
    error.metadata.get(GRPC_METADATA_KEYS.ERROR_CODE)[0];

  beforeAll(async () => {
    const env: Record<string, string> = {
      LOG_LEVEL: 'silent',
      SERVICE_NAME: 'billing-service',
      // Port 0: the server binds an OS-chosen port, read back after it started.
      GRPC_URL: '127.0.0.1:0',
      GRPC_DEADLINE_MS: '3000',
      STRIPE_SECRET_KEY: 'sk_test_billing_service_enforce_e2e',
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      // Nothing may reach real infrastructure: unreachable ports wherever a client could connect.
      DATABASE_URL: 'postgres://app:app@127.0.0.1:1/app',
      REDIS_URL: 'redis://127.0.0.1:1',
      KAFKA_BROKERS: '127.0.0.1:1',
      OUTBOX_RELAY_ENABLED: 'false',
      // A deployed service: it verifies with the edge's public key and holds no signing key.
      GRPC_PRINCIPAL_ASSERTION: 'enforce',
      GRPC_PRINCIPAL_PUBLIC_KEYS: signer.publicKeysEnv,
    };
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);

    // The default LEDGER_ENABLED (false): no immudb, no Kafka consumer.
    const builder = Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DRIZZLE)
      .useValue(postgres.db)
      .overrideProvider(REDIS_CLIENT)
      .useValue(new InMemoryRedis().asRedis())
      .overrideProvider(KafkaProducer)
      .useValue(new FakeKafkaProducer({ source: 'billing-service' }))
      .overrideProvider(StripeEventsSystemRepository)
      .useValue(systemEvents);
    const started = await withBoundGrpcPort(() =>
      startServiceTestApp(builder, { grpc: [BILLING_GRPC_PACKAGE] }),
    );
    app = started.value;
    const grpcUrl = `127.0.0.1:${started.port}`;

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

  it('refuses plain headers asserting admin (billing:read-all) for the whole tenant; no SQL runs', async () => {
    const before = postgres.executed.length;
    const error = await failureOf(listTenant(createOutgoingMetadata(admin)));
    expect(error.code).toBe(status.UNAUTHENTICATED);
    expect(errorCode(error)).toBe('INVALID_PRINCIPAL');
    expect(postgres.executed).toHaveLength(before); // refused before any handler ran
  });

  it('accepts the same call with a signed assertion: the admin lists the tenant, elevated', async () => {
    const before = postgres.executed.length;
    const list = await lastValueFrom(listTenant(signer.metadata(admin)));
    expect(list.items).toEqual([
      expect.objectContaining({ id: PAYMENT_ID, tenantId: TENANT_ID, userId: MEMBER_ID }),
    ]);
    // One unit of work as the asserted admin, elevated for billing:read-all before the query.
    expect(postgres.executed.slice(before).map((query) => query.sql)).toEqual([
      'BEGIN',
      `SET LOCAL app.user_id = '${ADMIN_ID}'; SET LOCAL app.tenant_id = '${TENANT_ID}'; SET LOCAL app.elevated = 'off'`,
      "SET LOCAL app.elevated = 'on'",
      expect.stringContaining('from "billing"."payments" where'),
      'COMMIT',
    ]);
  });

  it('the anonymous Stripe-signed webhook still passes (no principal headers, no assertion)', async () => {
    const webhook = signedWebhook('customer.created');
    await expect(
      lastValueFrom(
        billing.handleStripeWebhook({ payload: webhook.payload, signature: webhook.signature }),
      ),
    ).resolves.toEqual({
      received: true,
      eventId: webhook.id,
      eventType: 'customer.created',
      duplicate: false,
    });
    expect(systemEvents.events.filter((event) => event.id === webhook.id)).toEqual([
      expect.objectContaining({ tenantId: PLATFORM_TENANT_ID, type: 'customer.created' }),
    ]);
  });

  it('refuses an expired assertion', async () => {
    const before = postgres.executed.length;
    const late = Date.now() - (signer.signingKey.ttlSec + 60) * 1000;
    const error = await failureOf(listTenant(signer.metadata(admin, { nowMs: late })));
    expect(error.code).toBe(status.UNAUTHENTICATED);
    expect(errorCode(error)).toBe('INVALID_PRINCIPAL');
    expect(postgres.executed).toHaveLength(before);
  });
});

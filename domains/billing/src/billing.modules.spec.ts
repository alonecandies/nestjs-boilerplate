import { generateKeyPairSync } from 'node:crypto';
import { Global, type INestApplicationContext, Module, type Type } from '@nestjs/common';
import { CqrsModule, QueryBus } from '@nestjs/cqrs';
import { Test } from '@nestjs/testing';
import { RbacModule } from '@platform/auth';
import { TEST_TENANT_ID } from '@platform/auth/testing';
import { createPrincipal, generateId, runWithPrincipal } from '@platform/common';
import { AppConfigModule } from '@platform/config';
import {
  DRIZZLE,
  RlsElevation,
  SYSTEM_DATABASE,
  SystemDatabase,
  TransactionHost,
} from '@platform/database';
import { ImmudbClient } from '@platform/immudb';
import { RecordingImmudbClient } from '@platform/immudb/testing';
import { DistributedLockService } from '@platform/redis';
import { KafkaProducer } from '@platform/transport';
import { FakeKafkaProducer } from '@platform/transport/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRecordingDrizzle, installRlsTransactionHost } from '../test/billing-test.utils.js';
import { HandleStripeWebhookHandler } from './application/commands/handle-stripe-webhook/handle-stripe-webhook.handler.js';
import { R4StripeCheck } from './application/commands/reconcile-ledger/checks/r4-stripe.js';
import { ReconcileLedgerHandler } from './application/commands/reconcile-ledger/reconcile-ledger.handler.js';
import { LedgerService } from './application/ledger/ledger.service.js';
import { BillingPort } from './application/ports/billing.port.js';
import { LedgerPort } from './application/ports/ledger.port.js';
import { ListPaymentsQuery } from './application/queries/list-payments/list-payments.query.js';
import { LedgerSystemRepository } from './application/repositories/ledger.system-repository.js';
import { LedgerReceiptsRepository } from './application/repositories/ledger-receipts.repository.js';
import { PaymentsRepository } from './application/repositories/payments.repository.js';
import { BillingApiModule } from './billing-api.module.js';
import { BillingCoreModule } from './billing-core.module.js';
import { BillingGrpcModule } from './billing-grpc.module.js';
import { BillingMessagingModule } from './billing-messaging.module.js';
import { BillingGrpcAdapter } from './infrastructure/adapters/grpc/billing-grpc.adapter.js';
import { BillingLocalAdapter } from './infrastructure/adapters/local/billing-local.adapter.js';
import { DisabledLedger } from './infrastructure/ledger/disabled-ledger.js';
import { ImmudbLedgerAdapter } from './infrastructure/ledger/immudb-ledger.adapter.js';
import { BillingOutbox } from './infrastructure/persistence/billing-outbox.js';
import { BillingOutboxSystemRepository } from './infrastructure/persistence/drizzle-outbox.system-repository.js';
import { ReconcileLedgerCron } from './infrastructure/scheduling/reconcile-ledger.cron.js';
import { StripeService } from './infrastructure/stripe/stripe.service.js';
import { BillingGrpcController } from './presentation/grpc/billing-grpc.controller.js';
import { LedgerPostingConsumer } from './presentation/messaging/ledger-posting.consumer.js';

/**
 * What the apps' global infrastructure modules provide, faked (no Postgres, no Kafka): the real
 * RLS transaction host over a recording client, the elevation service (over the RbacModule's
 * permissions), a system database without a pool (so the outbox relay does not start) and a lock
 * service the relay injects (it never asks for a lock here). No Stripe:
 * BillingCoreModule brings its own adapter (a real client from the dev placeholder key, which
 * opens no connection until a call).
 */
function fakeInfrastructure() {
  const recording = createRecordingDrizzle();
  const host = installRlsTransactionHost(recording.db);

  @Global()
  @Module({
    providers: [
      { provide: DRIZZLE, useValue: recording.db },
      { provide: TransactionHost, useValue: host },
      { provide: SYSTEM_DATABASE, useValue: new SystemDatabase(null) },
      { provide: KafkaProducer, useValue: new FakeKafkaProducer() },
      {
        provide: DistributedLockService,
        useValue: { using: () => Promise.reject(new Error('no lock in a wiring spec')) },
      },
      RlsElevation,
    ],
    exports: [
      DRIZZLE,
      TransactionHost,
      SYSTEM_DATABASE,
      KafkaProducer,
      DistributedLockService,
      RlsElevation,
    ],
  })
  class FakeInfrastructureModule {}

  return { module: FakeInfrastructureModule, queries: recording.queries };
}

describe('billing modules (DI wiring per topology, no infrastructure)', () => {
  let context: INestApplicationContext | undefined;
  const userId = generateId();
  /** Listing needs a principal acting in the request tenant (B2-26): a member listing their own. */
  const asMember = <T>(fn: () => T): T =>
    runWithPrincipal(createPrincipal({ userId, tenantId: TEST_TENANT_ID, roles: ['member'] }), fn);

  afterEach(async () => {
    await context?.close();
    context = undefined;
  });

  it('billing-service: BillingGrpcModule resolves the core and the gRPC controller', async () => {
    const infra = fakeInfrastructure();
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppConfigModule.forRoot(),
        CqrsModule.forRoot(),
        RbacModule.forRoot(),
        infra.module,
        BillingGrpcModule,
      ],
    }).compile();
    context = await moduleRef.init();

    expect(context.get(BillingGrpcController)).toBeInstanceOf(BillingGrpcController);
    // The Stripe adapter comes with the core, not from an app-level module.
    expect(context.get(StripeService, { strict: false })).toBeInstanceOf(StripeService);
    // So does billing's outbox: the writer token and its system repository (OutboxModule).
    expect(context.get(BillingOutbox, { strict: false })).toBeInstanceOf(BillingOutbox);
    expect(context.get(BillingOutboxSystemRepository, { strict: false })).toBeInstanceOf(
      BillingOutboxSystemRepository,
    );
    // The reconciliation comes with the ledger (BillingMessagingModule), not with the core.
    expect(() => context?.get(ReconcileLedgerCron, { strict: false })).toThrow();
    // So do the ledger's repositories: no core provider uses them (final review F8).
    expect(() => context?.get(LedgerReceiptsRepository, { strict: false })).toThrow();
    expect(() => context?.get(LedgerSystemRepository, { strict: false })).toThrow();
    await expect(
      asMember(() =>
        context
          ?.get(QueryBus)
          .execute(new ListPaymentsQuery({ tenantId: TEST_TENANT_ID, userId, limit: 3 })),
      ),
    ).resolves.toEqual({
      items: [],
    });
    // LIMIT = page size + 1 look-ahead row (keyset pagination).
    expect(infra.queries.at(-1)?.params).toEqual([TEST_TENANT_ID, userId, 4]);
  });

  it('monolith: BillingApiModule.forLocal() binds BillingPort to the CQRS buses', async () => {
    const infra = fakeInfrastructure();
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppConfigModule.forRoot(),
        RbacModule.forRoot(),
        CqrsModule.forRoot(),
        infra.module,
        BillingCoreModule,
        BillingApiModule.forLocal(),
      ],
    }).compile();
    context = await moduleRef.init();

    const port = context.get(BillingPort, { strict: false });
    expect(port).toBeInstanceOf(BillingLocalAdapter);
    await expect(
      asMember(() => port.listPayments({ tenantId: TEST_TENANT_ID, userId, limit: 4 })),
    ).resolves.toEqual({
      items: [],
    });
    expect(infra.queries.at(-1)?.params).toEqual([TEST_TENANT_ID, userId, 5]);
  });

  it('gateway: BillingApiModule.forRemote() binds BillingPort to gRPC and needs no core', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule.forRoot(), RbacModule.forRoot(), BillingApiModule.forRemote()],
    }).compile();
    context = await moduleRef.init();

    expect(context.get(BillingPort, { strict: false })).toBeInstanceOf(BillingGrpcAdapter);
    expect(() => context?.get(PaymentsRepository, { strict: false })).toThrow();
  });
});

describe('BillingMessagingModule (L-12: the ledger-posting consumer and its ledger)', () => {
  let context: INestApplicationContext | undefined;

  afterEach(async () => {
    await context?.close();
    context = undefined;
    vi.unstubAllEnvs();
  });

  const boot = async (extra: Type[] = []) => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppConfigModule.forRoot(),
        RbacModule.forRoot(),
        CqrsModule.forRoot(),
        fakeInfrastructure().module,
        ...extra,
        BillingCoreModule,
        BillingMessagingModule,
      ],
    }).compile();
    return moduleRef.init();
  };

  it('LEDGER_ENABLED=false: the consumer resolves over a ledger that answers LEDGER_DISABLED', async () => {
    context = await boot();

    expect(context.get(LedgerPostingConsumer, { strict: false })).toBeInstanceOf(
      LedgerPostingConsumer,
    );
    expect(context.get(LedgerPort, { strict: false })).toBeInstanceOf(DisabledLedger);
    expect(context.get(LedgerService, { strict: false })).toBeInstanceOf(LedgerService);
  });

  @Global()
  @Module({
    providers: [{ provide: ImmudbClient, useValue: new RecordingImmudbClient() }],
    exports: [ImmudbClient],
  })
  class FakeImmudbModule {}

  it('LEDGER_ENABLED=true: LedgerPort is the immudb adapter over the global ImmudbClient', async () => {
    vi.stubEnv('LEDGER_ENABLED', 'true');

    context = await boot([FakeImmudbModule]);

    expect(context.get(LedgerPort, { strict: false })).toBeInstanceOf(ImmudbLedgerAdapter);
    // L-13: the reconciliation handler with R1-R4 and its hourly cron.
    expect(context.get(ReconcileLedgerCron, { strict: false })).toBeInstanceOf(ReconcileLedgerCron);
    expect(
      context.get(ReconcileLedgerHandler, { strict: false }).checks.map((check) => check.name),
    ).toEqual(['R1', 'R2', 'R3', 'R4']);
  });

  it('the ledger and the core share one Stripe client and one StripeService', async () => {
    vi.stubEnv('LEDGER_ENABLED', 'true');

    context = await boot([FakeImmudbModule]);

    const r4 = context.get(R4StripeCheck, { strict: false });
    const webhook = context.get(HandleStripeWebhookHandler, { strict: false });
    expect(r4['stripe']).toBeInstanceOf(StripeService);
    expect(r4['stripe']).toBe(webhook['stripe']);
  });

  it('LEDGER_VERIFY=true: the handler runs R5 last', async () => {
    vi.stubEnv('LEDGER_ENABLED', 'true');
    vi.stubEnv('LEDGER_VERIFY', 'true');

    context = await boot([FakeImmudbModule]);

    expect(
      context.get(ReconcileLedgerHandler, { strict: false }).checks.map((check) => check.name),
    ).toEqual(['R1', 'R2', 'R3', 'R4', 'R5']);
  });

  describe('production guard (Task 17): an enabled ledger is verified against a pinned key', () => {
    const KEY = Buffer.from(
      generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
        .publicKey.export({ type: 'spki', format: 'pem' })
        .toString(),
    ).toString('base64');
    /** Production with the ledger on and a Stripe setup production accepts, plus `env`. */
    const production = (env: Record<string, string>) => {
      for (const [key, value] of Object.entries({
        NODE_ENV: 'production',
        LEDGER_ENABLED: 'true',
        STRIPE_SECRET_KEY: 'sk_test_billing_modules_production',
        STRIPE_WEBHOOK_SECRET: 'whsec_billing_modules_production',
        STRIPE_SUCCESS_URL: 'https://app.example.com/billing/success',
        STRIPE_CANCEL_URL: 'https://app.example.com/billing/cancel',
        DATABASE_URL: 'postgres://app:secret-0001@db.example.com:6432/app?sslmode=verify-full',
        DATABASE_SYSTEM_URL:
          'postgres://system:secret-0002@db.example.com:6432/app?sslmode=verify-full',
        ...env,
      })) {
        vi.stubEnv(key, value);
      }
    };

    it.each([
      ['LEDGER_VERIFY=false', { IMMUDB_SERVER_SIGNING_PUBLIC_KEY: KEY }],
      ['no pinned key', { LEDGER_VERIFY: 'true' }],
    ])('refuses to start with %s, naming both variables', async (_case, env) => {
      production(env);

      const boot$ = boot([FakeImmudbModule]);

      await expect(boot$).rejects.toThrow(/LEDGER_VERIFY.*IMMUDB_SERVER_SIGNING_PUBLIC_KEY/s);
    });

    it.each([
      [
        'verified with a pinned key',
        { LEDGER_VERIFY: 'true', IMMUDB_SERVER_SIGNING_PUBLIC_KEY: KEY },
      ],
      ['LEDGER_ALLOW_UNVERIFIED=true', { LEDGER_ALLOW_UNVERIFIED: 'true' }],
    ])('starts %s', async (_case, env) => {
      production(env);

      context = await boot([FakeImmudbModule]);

      expect(context.get(LedgerPort, { strict: false })).toBeInstanceOf(ImmudbLedgerAdapter);
    });
  });

  it('LEDGER_ENABLED=true without ImmudbModule fails at boot, naming it', async () => {
    vi.stubEnv('LEDGER_ENABLED', 'true');

    await expect(boot()).rejects.toThrow(/ImmudbModule\.forRootAsync/);
  });
});

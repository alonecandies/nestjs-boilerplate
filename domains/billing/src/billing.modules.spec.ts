import { Global, type INestApplicationContext, Module } from '@nestjs/common';
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
import { KafkaProducer } from '@platform/transport';
import { FakeKafkaProducer } from '@platform/transport/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { createRecordingDrizzle, installRlsTransactionHost } from '../test/billing-test.utils.js';
import { BillingPort } from './application/ports/billing.port.js';
import { ListPaymentsQuery } from './application/queries/list-payments/list-payments.query.js';
import { PaymentsRepository } from './application/repositories/payments.repository.js';
import { BillingApiModule } from './billing-api.module.js';
import { BillingCoreModule } from './billing-core.module.js';
import { BillingGrpcModule } from './billing-grpc.module.js';
import { BillingGrpcAdapter } from './infrastructure/adapters/grpc/billing-grpc.adapter.js';
import { BillingLocalAdapter } from './infrastructure/adapters/local/billing-local.adapter.js';
import { StripeService } from './infrastructure/stripe/stripe.service.js';
import { BillingGrpcController } from './presentation/grpc/billing-grpc.controller.js';

/**
 * What the apps' global infrastructure modules provide, faked (no Postgres, no Kafka): the real
 * RLS transaction host over a recording client, the elevation service (over the RbacModule's
 * permissions), and a system database without a pool. No Stripe:
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
      RlsElevation,
    ],
    exports: [DRIZZLE, TransactionHost, SYSTEM_DATABASE, KafkaProducer, RlsElevation],
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

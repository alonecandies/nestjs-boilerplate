// Only identity's `UserModel` GraphQL type is referenced (by BillingResolver); keep the identity
// context out of this wiring test.
vi.mock('@app/identity', () => ({ UserModel: class UserModel {}, USERS_LOADER: 'users' }));

import { AppConfigModule } from '@app/config';
import { DRIZZLE, TransactionHost } from '@app/database';
import { StripeService } from '@app/payments';
import { FakeKafkaProducer, KafkaProducer } from '@app/transport';
import { Global, type INestApplicationContext, Module } from '@nestjs/common';
import { CqrsModule, QueryBus } from '@nestjs/cqrs';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRecordingDrizzle,
  createTestStripeService,
  installTestTransactionHost,
} from '../test/billing-test.utils.js';
import { BillingPort } from './application/ports/billing.port.js';
import { ListPaymentsQuery } from './application/queries/list-payments/list-payments.query.js';
import { PaymentsRepository } from './application/repositories/payments.repository.js';
import { BillingApiModule } from './billing-api.module.js';
import { BillingGrpcModule } from './billing-grpc.module.js';
import { BillingGrpcAdapter } from './infrastructure/adapters/grpc/billing-grpc.adapter.js';
import { BillingLocalAdapter } from './infrastructure/adapters/local/billing-local.adapter.js';
import { BillingGrpcController } from './presentation/grpc/billing-grpc.controller.js';

/** What the apps' global infrastructure modules provide, faked (no Postgres, Kafka, Stripe). */
function fakeInfrastructure() {
  const recording = createRecordingDrizzle();
  const { host } = installTestTransactionHost(undefined, recording.db);

  @Global()
  @Module({
    providers: [
      { provide: DRIZZLE, useValue: recording.db },
      { provide: TransactionHost, useValue: host },
      { provide: StripeService, useValue: createTestStripeService() },
      { provide: KafkaProducer, useValue: new FakeKafkaProducer() },
    ],
    exports: [DRIZZLE, TransactionHost, StripeService, KafkaProducer],
  })
  class FakeInfrastructureModule {}

  return { module: FakeInfrastructureModule, queries: recording.queries };
}

describe('billing modules (DI wiring per topology, no infrastructure)', () => {
  let context: INestApplicationContext | undefined;

  afterEach(async () => {
    await context?.close();
    context = undefined;
  });

  it('billing-service: BillingGrpcModule resolves the core and the gRPC controller', async () => {
    const infra = fakeInfrastructure();
    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule.forRoot(), CqrsModule.forRoot(), infra.module, BillingGrpcModule],
    }).compile();
    context = await moduleRef.init();

    expect(context.get(BillingGrpcController)).toBeInstanceOf(BillingGrpcController);
    await expect(
      context.get(QueryBus).execute(new ListPaymentsQuery({ limit: 3 })),
    ).resolves.toEqual({
      items: [],
    });
    // LIMIT = page size + 1 look-ahead row (keyset pagination).
    expect(infra.queries.at(-1)?.params).toEqual([4]);
  });

  it('monolith: BillingApiModule.forLocal() binds BillingPort to the CQRS buses', async () => {
    const infra = fakeInfrastructure();
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppConfigModule.forRoot(),
        CqrsModule.forRoot(),
        infra.module,
        BillingApiModule.forLocal(),
      ],
    }).compile();
    context = await moduleRef.init();

    const port = context.get(BillingPort, { strict: false });
    expect(port).toBeInstanceOf(BillingLocalAdapter);
    await expect(port.listPayments({ limit: 4 })).resolves.toEqual({ items: [] });
    expect(infra.queries.at(-1)?.params).toEqual([5]);
  });

  it('gateway: BillingApiModule.forRemote() binds BillingPort to gRPC and needs no core', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule.forRoot(), BillingApiModule.forRemote()],
    }).compile();
    context = await moduleRef.init();

    expect(context.get(BillingPort, { strict: false })).toBeInstanceOf(BillingGrpcAdapter);
    expect(() => context?.get(PaymentsRepository, { strict: false })).toThrow();
  });
});

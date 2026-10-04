import { AuthModule } from '@app/auth';
import { generateId, provideCommonEnhancers } from '@app/common';
import { AppConfigModule } from '@app/config';
import { DRIZZLE, TransactionHost } from '@app/database';
import { AppGraphqlModule, DataLoaderRegistry } from '@app/graphql';
import {
  IdentityApiModule,
  USERS_LOADER,
  type UserRecord,
  UsersPort,
  UsersRepository,
} from '@app/identity';
import { StripeService } from '@app/payments';
import { AppCacheService } from '@app/redis';
import { createFastifyTestApp, createMock } from '@app/testing';
import { FakeKafkaProducer, KafkaProducer } from '@app/transport';
import { Global, Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { GraphQLSchemaHost } from '@nestjs/graphql';
import { Test } from '@nestjs/testing';
import { printSchema } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  FakeRedisModule,
  loginAs,
  Role,
  type TestPrincipal,
} from '../test/billing-http-test.utils.js';
import {
  createRecordingDrizzle,
  createTestStripeService,
  InMemoryBillingStore,
  InMemoryPaymentsRepository,
  installTestTransactionHost,
  makePayment,
} from '../test/billing-test.utils.js';
import { BillingPort } from './application/ports/billing.port.js';
import { PaymentsRepository } from './application/repositories/payments.repository.js';
import { BillingApiModule } from './billing-api.module.js';
import { PaymentStatus } from './domain/payment-status.enum.js';
import { BillingLocalAdapter } from './infrastructure/adapters/local/billing-local.adapter.js';

/*
 * Cross-context composition, monolith-shaped: the REAL identity lib (IdentityApiModule.forLocal())
 * and billing (BillingApiModule.forLocal()) in ONE Nest app with ONE CQRS bus and ONE GraphQL
 * schema. The other billing specs mock `@app/identity`; this one proves the seam itself:
 * - both modules resolve together (no provider clash, no duplicate GraphQL type names);
 * - `Payment.user` is identity's `User` type;
 * - it resolves through identity's `users` DataLoader → UsersPort → QueryBus → GetUsersByIds
 *   handler → UsersRepository, in ONE batched lookup for a whole list of payments.
 * Only the persistence edges (repositories, Drizzle client, Stripe, Kafka, Redis) are fakes.
 */

type TestApp = Awaited<ReturnType<typeof createFastifyTestApp>>;

const store = new InMemoryBillingStore();
const users = new Map<string, UserRecord>();
const usersRepository = createMock<UsersRepository>({
  findByIds: async (ids: readonly string[]) =>
    ids.flatMap((id) => (users.has(id) ? [users.get(id) as UserRecord] : [])),
  findById: async (id: string) => users.get(id) ?? null,
});

const recording = createRecordingDrizzle();
const transactions = installTestTransactionHost(store, recording.db);

/** What the monolith's global infrastructure modules provide, faked. */
@Global()
@Module({
  providers: [
    { provide: DRIZZLE, useValue: recording.db },
    { provide: TransactionHost, useValue: transactions.host },
    { provide: StripeService, useValue: createTestStripeService() },
    { provide: KafkaProducer, useValue: new FakeKafkaProducer({ source: 'monolith' }) },
    // A createMock() provider inside an app that boots GraphQLModule (regression: the explorer
    // used to crash on the proxy's prototype / constructor).
    {
      provide: AppCacheService,
      useValue: createMock<AppCacheService>({
        getOrSet: async (_key: string, loader: () => Promise<unknown>) => loader(),
        del: async () => undefined,
      }),
    },
  ],
  exports: [DRIZZLE, TransactionHost, StripeService, KafkaProducer, AppCacheService],
})
class FakeInfrastructureModule {}

const PAYMENTS_QUERY = /* GraphQL */ `
  query Payments {
    payments(all: true, limit: 10) {
      items {
        id
        status
        user { id email displayName roles }
      }
      nextCursor
    }
  }
`;

const userRecord = (displayName: string): UserRecord => {
  const now = new Date('2026-09-01T00:00:00.000Z');
  return {
    id: generateId(),
    email: `${displayName.toLowerCase()}@example.com`,
    displayName,
    roles: ['user'],
    createdAt: now,
    updatedAt: now,
  };
};

describe('identity + billing composed in one app (monolith wiring, real identity lib)', () => {
  let app: TestApp;
  let admin: TestPrincipal;
  const ada = userRecord('Ada');
  const alan = userRecord('Alan');

  beforeAll(async () => {
    users.set(ada.id, ada);
    users.set(alan.id, alan);
    store.seed(
      makePayment({ userId: ada.id, status: PaymentStatus.Succeeded }),
      makePayment({ userId: alan.id, status: PaymentStatus.Succeeded }),
      makePayment({ userId: ada.id, status: PaymentStatus.Pending }),
    );

    const builder = Test.createTestingModule({
      imports: [
        AppConfigModule.forRoot(),
        FakeRedisModule,
        AuthModule.forRootAsync(),
        AppGraphqlModule.forRootAsync(),
        CqrsModule.forRoot(),
        FakeInfrastructureModule,
        IdentityApiModule.forLocal(),
        BillingApiModule.forLocal(),
      ],
      providers: provideCommonEnhancers({ exposeInternalErrors: true }),
    })
      .overrideProvider(PaymentsRepository)
      .useValue(new InMemoryPaymentsRepository(store))
      .overrideProvider(UsersRepository)
      .useValue(usersRepository);
    app = await createFastifyTestApp(builder, undefined, { appOptions: { logger: false } });
    admin = await loginAs(app, Role.Admin);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    usersRepository.findByIds.mockClear();
  });

  it('binds both contexts to their in-process adapters and registers the users loader', () => {
    expect(app.get(BillingPort, { strict: false })).toBeInstanceOf(BillingLocalAdapter);
    expect(app.get(UsersPort, { strict: false }).constructor.name).toBe('UsersLocalAdapter');
    expect(app.get(DataLoaderRegistry).names()).toEqual([USERS_LOADER]);
  });

  it('builds one schema where Payment.user is identity’s User type', () => {
    const sdl = printSchema(app.get(GraphQLSchemaHost).schema);
    expect(sdl).toMatch(/type Payment \{[^}]*\buser: User\b/);
    expect(sdl.match(/^type User \{/gm)).toHaveLength(1);
    for (const type of ['UserConnection', 'AuthPayload', 'CheckoutSession']) {
      expect(sdl).toContain(`type ${type} {`);
    }
  });

  it('resolves Payment.user for a whole list with ONE users lookup', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/graphql',
      headers: { 'content-type': 'application/json', authorization: admin.authorization },
      payload: { query: PAYMENTS_QUERY },
    });

    const body = res.json<{
      data?: {
        payments: {
          items: { id: string; user: { id: string; email: string } | null }[];
          nextCursor: string | null;
        };
      };
      errors?: unknown[];
    }>();
    expect(body.errors).toBeUndefined();
    expect(body.data?.payments.items).toHaveLength(3);
    expect(body.data?.payments.nextCursor).toBeNull();
    // Every payment got its owner: Ada has two payments, Alan one.
    expect(body.data?.payments.items.map((p) => p.user?.email).sort()).toEqual(
      [ada.email, ada.email, alan.email].sort(),
    );
    expect(body.data?.payments.items.map((p) => p.user)).toContainEqual({
      id: alan.id,
      email: alan.email,
      displayName: 'Alan',
      roles: ['USER'],
    });
    // Three payments, two distinct users: one GetUsersByIds → one repository call.
    expect(usersRepository.findByIds).toHaveBeenCalledTimes(1);
    expect([...(usersRepository.findByIds.mock.calls[0]?.[0] ?? [])].sort()).toEqual(
      [ada.id, alan.id].sort(),
    );
  });

  it('serves both REST surfaces from the same app (/v1/billing and /v1/users)', async () => {
    const payments = await app.inject({
      method: 'GET',
      url: '/v1/billing/payments?all=true',
      headers: { authorization: admin.authorization },
    });
    expect(payments.statusCode).toBe(200);
    expect(payments.json<{ items: unknown[] }>().items).toHaveLength(3);

    const user = await app.inject({
      method: 'GET',
      url: `/v1/users/${ada.id}`,
      headers: { authorization: admin.authorization },
    });
    expect(user.statusCode).toBe(200);
    expect(user.json()).toMatchObject({ id: ada.id, email: ada.email });
  });
});

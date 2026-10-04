// Isolate from the identity context: only its `UserModel` GraphQL type is needed here.
vi.mock('@app/identity', async () => {
  const { Field, ID, ObjectType } = await import('@nestjs/graphql');
  @ObjectType('User')
  class UserModel {
    @Field(() => ID)
    id: string;

    @Field()
    displayName: string;
  }
  return { UserModel, USERS_LOADER: 'users' };
});

import { AuthModule } from '@app/auth';
import { generateId, provideCommonEnhancers } from '@app/common';
import { AppConfigModule } from '@app/config';
import type { Payment } from '@app/contracts';
import { AppGraphqlModule, DataLoaderRegistry } from '@app/graphql';
import { createFastifyTestApp, type Mocked } from '@app/testing';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import DataLoader from 'dataloader';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FakeRedisModule,
  loginAs,
  Role,
  type TestPrincipal,
} from '../../../test/billing-http-test.utils.js';
import { BillingPort } from '../../application/ports/billing.port.js';
import { BillingResolver } from './billing.resolver.js';

/** `NestFastifyApplication`, typed through @app/testing (billing does not depend on platform-fastify). */
type TestApp = Awaited<ReturnType<typeof createFastifyTestApp>>;

/** What identity's registrar does: one batched `getUsersByIds` per operation. */
const userBatches: string[][] = [];

@Injectable()
class UsersLoaderStub implements OnModuleInit {
  constructor(private readonly registry: DataLoaderRegistry) {}

  onModuleInit(): void {
    this.registry.register(
      'users',
      () =>
        new DataLoader<string, { id: string; displayName: string } | null>(async (ids) => {
          userBatches.push([...ids]);
          return ids.map((id) => ({ id, displayName: `user ${id.slice(-4)}` }));
        }),
    );
  }
}

const PAYMENTS_QUERY = /* GraphQL */ `
  query Payments($all: Boolean, $cursor: String) {
    payments(all: $all, limit: 10, cursor: $cursor) {
      items {
        id
        status
        amountTotal
        currency
        createdAt
        user { id displayName }
      }
      nextCursor
    }
  }
`;

const CHECKOUT_MUTATION = /* GraphQL */ `
  mutation Checkout($input: CreateCheckoutSessionInput!) {
    createCheckoutSession(input: $input) { id url paymentId }
  }
`;

interface GraphqlBody {
  data?: Record<string, unknown> | null;
  errors?: { message: string; extensions?: { code?: string; status?: number } }[];
}

describe('BillingResolver (Apollo on Fastify, real guards, fake BillingPort)', () => {
  let app: TestApp;
  let port: Mocked<BillingPort>;
  let user: TestPrincipal;
  let admin: TestPrincipal;
  let moderator: TestPrincipal;

  const gql = async (
    query: string,
    variables: Record<string, unknown>,
    principal?: TestPrincipal,
  ): Promise<GraphqlBody> => {
    const res = await app.inject({
      method: 'POST',
      url: '/graphql',
      headers: {
        'content-type': 'application/json',
        ...(principal ? { authorization: principal.authorization } : {}),
      },
      payload: { query, variables },
    });
    return res.json<GraphqlBody>();
  };

  const payment = (userId: string, overrides: Partial<Payment> = {}): Payment => ({
    id: generateId(),
    userId,
    status: 'succeeded',
    amountTotal: '2500',
    currency: 'usd',
    priceId: 'price_1',
    quantity: 1,
    createdAt: new Date('2026-09-01T10:00:00.000Z'),
    ...overrides,
  });

  beforeAll(async () => {
    // A plain object, not the Proxy-based createMock(): Nest's resolver explorer scans every
    // provider's prototype, and a Proxy that answers every property confuses it.
    port = {
      createCheckoutSession: vi.fn(),
      handleStripeWebhook: vi.fn(),
      listPayments: vi.fn(),
    };
    const builder = Test.createTestingModule({
      imports: [
        AppConfigModule.forRoot(),
        FakeRedisModule,
        AuthModule.forRootAsync(),
        AppGraphqlModule.forRootAsync(),
      ],
      providers: [
        BillingResolver,
        UsersLoaderStub,
        { provide: BillingPort, useValue: port },
        ...provideCommonEnhancers({ exposeInternalErrors: true }),
      ],
    });
    app = await createFastifyTestApp(builder, undefined, { appOptions: { logger: false } });
    [user, admin, moderator] = await Promise.all([
      loginAs(app, Role.User),
      loginAs(app, Role.Admin),
      loginAs(app, Role.Moderator),
    ]);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    port.listPayments.mockReset();
    port.createCheckoutSession.mockReset();
    userBatches.length = 0;
  });

  describe('Query.payments', () => {
    it("returns the caller's payments with users resolved in ONE batch", async () => {
      const other = generateId();
      port.listPayments.mockResolvedValue({
        items: [
          payment(user.id),
          payment(user.id),
          payment(other, { amountTotal: '0', currency: '' }),
        ],
      });

      const body = await gql(PAYMENTS_QUERY, {}, user);

      expect(body.errors).toBeUndefined();
      expect(port.listPayments).toHaveBeenCalledWith({ userId: user.id, limit: 10 });
      const connection = body.data?.['payments'] as {
        items: Record<string, unknown>[];
        nextCursor: string | null;
      };
      expect(connection.nextCursor).toBeNull();
      const { items } = connection;
      expect(items).toHaveLength(3);
      expect(items[0]).toMatchObject({
        status: 'SUCCEEDED',
        amountTotal: 2500,
        currency: 'usd',
        createdAt: '2026-09-01T10:00:00.000Z',
        user: { id: user.id },
      });
      expect(userBatches).toEqual([[user.id, other]]);
    });

    it('all: true is FORBIDDEN without billing:read-all', async () => {
      const body = await gql(PAYMENTS_QUERY, { all: true }, user);

      expect(body.errors?.[0]?.extensions).toMatchObject({ code: 'FORBIDDEN', status: 403 });
      expect(port.listPayments).not.toHaveBeenCalled();
    });

    it('all: true lists every user for an admin', async () => {
      port.listPayments.mockResolvedValue({ items: [] });

      const body = await gql(PAYMENTS_QUERY, { all: true }, admin);

      expect(body.errors).toBeUndefined();
      expect(port.listPayments).toHaveBeenCalledWith({ userId: undefined, limit: 10 });
    });

    it('pages: cursor in, nextCursor out', async () => {
      port.listPayments.mockResolvedValue({ items: [payment(user.id)], nextCursor: 'cursor-2' });

      const body = await gql(PAYMENTS_QUERY, { cursor: 'cursor-1' }, user);

      expect(body.errors).toBeUndefined();
      expect(port.listPayments).toHaveBeenCalledWith({
        userId: user.id,
        limit: 10,
        cursor: 'cursor-1',
      });
      expect(body.data?.['payments']).toMatchObject({ nextCursor: 'cursor-2' });
    });

    it('requires authentication', async () => {
      const body = await gql(PAYMENTS_QUERY, {});
      expect(body.errors?.[0]?.extensions?.status).toBe(401);
    });
  });

  describe('Mutation.createCheckoutSession', () => {
    const session = {
      id: 'cs_1',
      url: 'https://checkout.stripe.com/c/pay/cs_1',
      paymentId: generateId(),
    };

    it('creates a session for a user (billing:checkout)', async () => {
      port.createCheckoutSession.mockResolvedValue(session);

      const body = await gql(
        CHECKOUT_MUTATION,
        { input: { priceId: 'price_1', idempotencyKey: 'order-7-attempt' } },
        user,
      );

      expect(body.errors).toBeUndefined();
      expect(body.data?.['createCheckoutSession']).toEqual(session);
      expect(port.createCheckoutSession).toHaveBeenCalledWith({
        userId: user.id,
        customerEmail: user.email,
        priceId: 'price_1',
        quantity: 1,
        idempotencyKey: 'order-7-attempt',
      });
    });

    it('is FORBIDDEN without billing:checkout (moderator)', async () => {
      const body = await gql(CHECKOUT_MUTATION, { input: { priceId: 'price_1' } }, moderator);

      expect(body.errors?.[0]?.extensions).toMatchObject({ code: 'FORBIDDEN', status: 403 });
      expect(port.createCheckoutSession).not.toHaveBeenCalled();
    });

    it.each([
      [{ priceId: 'price_1', quantity: 0 }],
      [{ priceId: '' }],
      [{ priceId: 'price_1', idempotencyKey: 'bad key!' }],
    ])('rejects invalid input %j with a 400', async (input) => {
      const body = await gql(CHECKOUT_MUTATION, { input }, user);

      expect(body.errors?.[0]?.extensions?.status).toBe(400);
      expect(port.createCheckoutSession).not.toHaveBeenCalled();
    });
  });
});

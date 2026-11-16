import type { Payment } from '@domain/billing-contracts';
import { GraphQLSchemaHost } from '@nestjs/graphql';
import { Test } from '@nestjs/testing';
import { AuthModule, RbacModule } from '@platform/auth';
import { generateId, provideCommonEnhancers } from '@platform/common';
import { AppConfigModule } from '@platform/config';
import { AppGraphqlModule } from '@platform/graphql';
import { createFastifyTestApp, type Mocked } from '@platform/testing';
import { printSchema } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FakeRedisModule,
  loginAs,
  type TestPrincipal,
} from '../../../test/billing-http-test.utils.js';
import { BillingPort } from '../../application/ports/billing.port.js';
import { BILLING_RBAC } from '../../billing.permissions.js';
import { BillingResolver } from './billing.resolver.js';

/** `NestFastifyApplication`, typed through @platform/testing (billing does not depend on platform-fastify). */
type TestApp = Awaited<ReturnType<typeof createFastifyTestApp>>;

const PAYMENTS_QUERY = /* GraphQL */ `
  query Payments($all: Boolean, $cursor: String) {
    payments(all: $all, limit: 10, cursor: $cursor) {
      items {
        id
        status
        amountTotal
        currency
        createdAt
        userId
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
        RbacModule.forFeature(BILLING_RBAC),
        AppGraphqlModule.forRootAsync(),
      ],
      providers: [
        BillingResolver,
        { provide: BillingPort, useValue: port },
        ...provideCommonEnhancers({ exposeInternalErrors: true }),
      ],
    });
    app = await createFastifyTestApp(builder, undefined, { appOptions: { logger: false } });
    [user, admin, moderator] = await Promise.all([
      loginAs(app, 'member'),
      loginAs(app, 'admin'),
      loginAs(app),
    ]);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    port.listPayments.mockReset();
    port.createCheckoutSession.mockReset();
  });

  describe('Query.payments', () => {
    it("returns the caller's payments, each with its owner's userId", async () => {
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
        userId: user.id,
      });
      expect(items[2]).toMatchObject({ userId: other });
    });

    it('all: true is FORBIDDEN without billing:read-all', async () => {
      const body = await gql(PAYMENTS_QUERY, { all: true }, user);

      expect(body.errors?.[0]?.extensions).toMatchObject({ code: 'FORBIDDEN', status: 403 });
      expect(port.listPayments).not.toHaveBeenCalled();
    });

    it('all: true is FORBIDDEN even for an admin (billing:read-all withheld until B2-26)', async () => {
      const body = await gql(PAYMENTS_QUERY, { all: true }, admin);
      expect(body.errors?.[0]?.extensions).toMatchObject({ code: 'FORBIDDEN', status: 403 });
      expect(port.listPayments).not.toHaveBeenCalled();
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

    it('is FORBIDDEN without billing:checkout (no role)', async () => {
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

  describe('schema', () => {
    it('exposes the owner as Payment.userId only: the apps compose Payment.user', () => {
      const sdl = printSchema(app.get(GraphQLSchemaHost).schema);

      expect(sdl).toMatch(/type Payment \{[^}]*\buserId: UUID!/);
      expect(sdl).not.toMatch(/type Payment \{[^}]*\buser:/);
    });
  });
});

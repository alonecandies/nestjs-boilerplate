/*
 * Payment.user in the microservices topology. The gateway composes `Payment.user`
 * (`src/graphql/payment-user.resolver.ts`) over two remote ports. Billing's port lists the payments
 * (a stub here, in place of billing-service; billing's roundtrip spec covers the real gRPC hop).
 * Identity's `users` DataLoader resolves the owners through UsersPort (the fake identity-service)
 * in ONE GetUsersByIds call per operation.
 */
await vi.hoisted(async () => {
  const { GATEWAY_E2E_ENV } = await import('./support/e2e-env.js');
  Object.assign(process.env, GATEWAY_E2E_ENV);
});

import { GraphQLSchemaHost } from '@nestjs/graphql';
import { generateId } from '@platform/common';
import { printSchema } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaymentUserFieldResolver } from '../src/graphql/payment-user.resolver.js';
import { createGatewayE2eApp, type GatewayE2e } from './support/gateway-e2e-app.js';
import { bearer, graphql } from './support/http.js';

interface AuthTokensBody {
  accessToken: string;
  user: { id: string; email: string; displayName: string };
}

interface PaymentsBody {
  data?: {
    payments: {
      items: {
        id: string;
        userId: string;
        user: { id: string; email: string; displayName: string } | null;
      }[];
      nextCursor: string | null;
    };
  };
  errors?: unknown[];
}

const PASSWORD = 'a very long passphrase';
const PAYMENTS_QUERY = /* GraphQL */ `
  query Payments {
    payments(limit: 10) {
      items {
        id
        userId
        user { id email displayName }
      }
      nextCursor
    }
  }
`;

/** billing-service, stubbed at its port: each test sets the page once the owners exist. */
const billing = {
  createCheckoutSession: vi.fn(),
  handleStripeWebhook: vi.fn(),
  listPayments: vi.fn(),
};

/** A `billing.v1.Payment` as `BillingPort.listPayments` returns it. */
const payment = (userId: string) => ({
  id: generateId(),
  userId,
  status: 'succeeded',
  amountTotal: '2500',
  currency: 'usd',
  priceId: 'price_e2e',
  quantity: 1,
  createdAt: new Date('2026-09-01T10:00:00.000Z'),
});

describe('Payment.user in the gateway (app-level resolver over the remote ports)', () => {
  let e2e: GatewayE2e;
  let grace: AuthTokensBody;
  let alan: AuthTokensBody;
  let callerToken: string;

  const inject = (...args: Parameters<GatewayE2e['app']['inject']>) => e2e.app.inject(...args);

  const register = async (email: string, displayName: string): Promise<AuthTokensBody> => {
    const response = await inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email, password: PASSWORD, displayName },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<AuthTokensBody>();
  };

  const queryPayments = async (): Promise<PaymentsBody> => {
    const response = await inject(graphql(PAYMENTS_QUERY, undefined, bearer(callerToken)));
    expect(response.statusCode, response.body).toBe(200);
    return response.json<PaymentsBody>();
  };

  beforeAll(async () => {
    e2e = await createGatewayE2eApp({ billing });
    grace = await register('grace@example.com', 'Grace');
    alan = await register('alan@example.com', 'Alan');
    callerToken = grace.accessToken;
  });

  afterAll(async () => {
    await e2e?.app.close();
  });

  beforeEach(() => {
    e2e.identity.calls.length = 0;
  });

  it('registers PaymentUserFieldResolver: one schema where Payment.user is identity’s User', () => {
    expect(e2e.app.get(PaymentUserFieldResolver)).toBeInstanceOf(PaymentUserFieldResolver);
    const sdl = printSchema(e2e.app.get(GraphQLSchemaHost).schema);
    expect(sdl).toMatch(/type Payment \{[^}]*\buser: User\b/);
    expect(sdl).toMatch(/type Payment \{[^}]*\buserId: UUID!/);
    expect(sdl.match(/^type User \{/gm)).toHaveLength(1);
  });

  it('resolves Payment.user for a page with ONE GetUsersByIds call to identity-service', async () => {
    billing.listPayments.mockResolvedValue({
      items: [payment(grace.user.id), payment(alan.user.id), payment(grace.user.id)],
    });

    const body = await queryPayments();

    expect(body.errors).toBeUndefined();
    expect(billing.listPayments).toHaveBeenCalledWith({ userId: grace.user.id, limit: 10 });
    const items = body.data?.payments.items ?? [];
    expect(items.map((item) => item.user?.email)).toEqual([
      'grace@example.com',
      'alan@example.com',
      'grace@example.com',
    ]);
    expect(items[1]?.user).toEqual({
      id: alan.user.id,
      email: 'alan@example.com',
      displayName: 'Alan',
    });
    expect(e2e.identity.calls.filter((call) => call === 'UsersService.GetUsersByIds')).toHaveLength(
      1,
    );
  });

  it('resolves user to null when the owner no longer exists', async () => {
    const gone = generateId();
    billing.listPayments.mockResolvedValue({ items: [payment(gone)] });

    const body = await queryPayments();

    expect(body.errors).toBeUndefined();
    expect(body.data?.payments.items).toEqual([
      expect.objectContaining({ userId: gone, user: null }),
    ]);
  });
});

/*
 * Payment.user in the monolith topology. Billing exposes a payment's owner as `Payment.userId`
 * only; the composition root adds `Payment.user` (`src/graphql/payment-user.resolver.ts`) and
 * resolves it through identity's `users` DataLoader → UsersLocalAdapter → QueryBus →
 * GetUsersByIds → UsersRepository, in ONE batched lookup per operation. Payments come from the
 * fake Postgres (rows answered by position, as postgres.js does), users from the in-memory
 * identity store, registered through the REST API.
 */
await vi.hoisted(async () => {
  const { MONOLITH_E2E_ENV } = await import('./support/e2e-env.js');
  Object.assign(process.env, MONOLITH_E2E_ENV);
});

import { PaymentStatus, payments } from '@domain/billing';
import { GraphQLSchemaHost } from '@nestjs/graphql';
import { generateId } from '@platform/common';
import { getTableColumns } from 'drizzle-orm';
import { printSchema } from 'graphql';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PaymentUserFieldResolver } from '../src/graphql/payment-user.resolver.js';
import type { FakeRows } from './support/fake-infrastructure.js';
import { bearer, graphql } from './support/http.js';
import { createMonolithE2eApp, type MonolithE2e } from './support/monolith-e2e-app.js';

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

const PASSWORD = 'correct horse battery staple';
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
const AT = '2026-09-01T10:00:00.000Z';

/** A paid `payments` row as postgres.js returns it: values in column order, int8 as a string. */
function paymentRow(userId: string): FakeRows[number] {
  const values: Record<string, unknown> = {
    id: generateId(),
    userId,
    priceId: 'price_e2e',
    quantity: 1,
    amountTotal: '2500',
    currency: 'usd',
    status: PaymentStatus.Succeeded,
    stripeCheckoutSessionId: `cs_e2e_${generateId()}`,
    paidAt: AT,
    version: 1,
    createdAt: AT,
    updatedAt: AT,
  };
  return Object.fromEntries(
    Object.keys(getTableColumns(payments)).map((column) => [column, values[column] ?? null]),
  );
}

describe('Payment.user in the monolith (app-level resolver over the local ports)', () => {
  let e2e: MonolithE2e;
  let paymentRows: FakeRows = [];
  let ada: AuthTokensBody;
  let alan: AuthTokensBody;
  let callerToken: string;

  const inject = (...args: Parameters<MonolithE2e['app']['inject']>) => e2e.app.inject(...args);

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
    e2e = await createMonolithE2eApp({
      postgresRows: (sql) =>
        sql.startsWith('select') && sql.includes('"billing"."payments"') ? paymentRows : [],
    });
    ada = await register('ada@example.com', 'Ada');
    alan = await register('alan@example.com', 'Alan');
    callerToken = ada.accessToken;
  });

  afterAll(async () => {
    await e2e?.app.close();
  });

  it('registers PaymentUserFieldResolver: one schema where Payment.user is identity’s User', () => {
    expect(e2e.app.get(PaymentUserFieldResolver)).toBeInstanceOf(PaymentUserFieldResolver);
    const sdl = printSchema(e2e.app.get(GraphQLSchemaHost).schema);
    expect(sdl).toMatch(/type Payment \{[^}]*\buser: User\b/);
    expect(sdl).toMatch(/type Payment \{[^}]*\buserId: UUID!/);
    expect(sdl.match(/^type User \{/gm)).toHaveLength(1);
  });

  it('resolves Payment.user for a page of payments with ONE batched users lookup', async () => {
    paymentRows = [paymentRow(ada.user.id), paymentRow(alan.user.id), paymentRow(ada.user.id)];
    const findByIds = vi.spyOn(e2e.identity.users, 'findByIds');

    const body = await queryPayments();

    expect(body.errors).toBeUndefined();
    const items = body.data?.payments.items ?? [];
    expect(items.map((payment) => payment.user?.email)).toEqual([
      'ada@example.com',
      'alan@example.com',
      'ada@example.com',
    ]);
    expect(items.every((payment) => payment.user?.id === payment.userId)).toBe(true);
    expect(items[1]?.user).toEqual({
      id: alan.user.id,
      email: 'alan@example.com',
      displayName: 'Alan',
    });
    // Three payments, two distinct owners: one GetUsersByIds query, one repository call.
    expect(findByIds).toHaveBeenCalledTimes(1);
    expect([...(findByIds.mock.calls[0]?.[0] ?? [])].sort()).toEqual(
      [ada.user.id, alan.user.id].sort(),
    );
  });

  it('resolves user to null when the owner no longer exists', async () => {
    const gone = generateId();
    paymentRows = [paymentRow(gone)];

    const body = await queryPayments();

    expect(body.errors).toBeUndefined();
    expect(body.data?.payments.items).toEqual([
      expect.objectContaining({ userId: gone, user: null }),
    ]);
  });
});

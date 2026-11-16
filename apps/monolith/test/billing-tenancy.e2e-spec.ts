/*
 * Billing is tenant-scoped in the monolith (B2-26): `all=true` lists the caller's ACTIVE tenant
 * only. Payments come from the fake Postgres, which records the bound parameters of every listing
 * so the test can see which tenant the statement named.
 */
await vi.hoisted(async () => {
  const { MONOLITH_E2E_ENV } = await import('./support/e2e-env.js');
  Object.assign(process.env, MONOLITH_E2E_ENV);
});

import { PaymentStatus, payments } from '@domain/billing';
import { generateId } from '@platform/common';
import { getTableColumns } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMonolithE2eApp, type MonolithE2e } from './support/monolith-e2e-app.js';

interface Tokens {
  accessToken: string;
  tenantId: string;
  user: { id: string };
}
const AT = '2026-09-01T10:00:00.000Z';

describe('billing is tenant-scoped (monolith, B2-26)', () => {
  let e2e: MonolithE2e;
  const listings: unknown[][] = [];
  let ada: Tokens;
  let bob: Tokens;

  const row = (tenantId: string, userId: string) => {
    const values: Record<string, unknown> = {
      tenantId,
      id: generateId(),
      userId,
      priceId: 'price_e2e',
      quantity: 1,
      amountTotal: '2500',
      currency: 'usd',
      status: PaymentStatus.Succeeded,
      version: 1,
      createdAt: AT,
      updatedAt: AT,
    };
    return Object.fromEntries(
      Object.keys(getTableColumns(payments)).map((c) => [c, values[c] ?? null]),
    );
  };

  const register = async (email: string): Promise<Tokens> => {
    const res = await e2e.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email, password: 'correct horse battery staple', displayName: email },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<Tokens>();
  };

  beforeAll(async () => {
    e2e = await createMonolithE2eApp({
      postgresRows: (sql, params) => {
        if (!sql.startsWith('select') || !sql.includes('"billing"."payments"')) return [];
        listings.push(params);
        const tenantId = params.find((p) => p === ada?.tenantId || p === bob?.tenantId);
        return typeof tenantId === 'string' ? [row(tenantId, ada.user.id)] : [];
      },
    });
    ada = await register('ada.billing@example.com');
    bob = await register('bob.billing@example.com');
  });

  afterAll(async () => {
    await e2e?.app.close();
  });

  it("all=true from an owner reads only the owner's active tenant", async () => {
    const res = await e2e.app.inject({
      method: 'GET',
      url: '/v1/billing/payments?all=true&limit=5',
      headers: { authorization: `Bearer ${ada.accessToken}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(listings.at(-1)).toContain(ada.tenantId);
    expect(listings.at(-1)).not.toContain(bob.tenantId);
  });

  it('GraphQL payments(all: true) is scoped the same way', async () => {
    const res = await e2e.app.inject({
      method: 'POST',
      url: '/graphql',
      headers: { authorization: `Bearer ${bob.accessToken}`, 'content-type': 'application/json' },
      payload: { query: '{ payments(all: true, limit: 5) { items { id userId } } }' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ errors?: unknown }>().errors).toBeUndefined();
    expect(listings.at(-1)).toContain(bob.tenantId);
    expect(listings.at(-1)).not.toContain(ada.tenantId);
  });
});

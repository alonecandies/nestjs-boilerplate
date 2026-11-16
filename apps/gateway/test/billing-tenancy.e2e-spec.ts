/*
 * Billing through the gateway is tenant-scoped (B2-26): `all=true` forwards the caller's active
 * tenant (the `tid` claim of the access token) and no user. BillingPort is a stub, so this pins
 * what the gateway puts on the wire.
 */
await vi.hoisted(async () => {
  const { GATEWAY_E2E_ENV } = await import('./support/e2e-env.js');
  Object.assign(process.env, GATEWAY_E2E_ENV);
});

import type { BillingPort } from '@domain/billing';
import { createMock } from '@platform/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createGatewayE2eApp, type GatewayE2e } from './support/gateway-e2e-app.js';

interface AuthTokensBody {
  accessToken: string;
  tenantId: string;
  user: { id: string };
}

describe('billing is tenant-scoped (gateway, B2-26)', () => {
  let e2e: GatewayE2e;
  const billing = createMock<BillingPort>({
    listPayments: vi.fn().mockResolvedValue({ items: [] }),
  });

  beforeAll(async () => {
    e2e = await createGatewayE2eApp({ billing });
  });

  afterAll(async () => {
    await e2e?.app.close();
  });

  it('GET /v1/billing/payments?all=true forwards the active tenant and no user', async () => {
    const registered = await e2e.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'ada.billing.gw@example.com',
        password: 'correct horse battery staple',
        displayName: 'Ada',
      },
    });
    expect(registered.statusCode, registered.body).toBe(201);
    const tokens = registered.json<AuthTokensBody>();

    const res = await e2e.app.inject({
      method: 'GET',
      url: '/v1/billing/payments?all=true',
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });

    expect(res.statusCode, res.body).toBe(200);
    // 20 = BILLING_LIMITS.DEFAULT_PAGE_SIZE, the REST default.
    expect(billing.listPayments).toHaveBeenCalledWith({ tenantId: tokens.tenantId, limit: 20 });
  });
});

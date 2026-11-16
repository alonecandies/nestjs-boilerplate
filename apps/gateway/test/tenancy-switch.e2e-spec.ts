await vi.hoisted(async () => {
  const { GATEWAY_E2E_ENV } = await import('./support/e2e-env.js');
  Object.assign(process.env, GATEWAY_E2E_ENV);
});

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createGatewayE2eApp, type GatewayE2e } from './support/gateway-e2e-app.js';

interface AuthTokensBody {
  accessToken: string;
  refreshToken: string;
  tenantId: string;
  tenantRoles: string[];
  user: { id: string };
}
const PASSWORD = 'correct horse battery staple';

describe('switch tenant through the gateway (fake identity-service)', () => {
  let e2e: GatewayE2e;
  const inject = (...args: Parameters<GatewayE2e['app']['inject']>) => e2e.app.inject(...args);

  beforeAll(async () => {
    e2e = await createGatewayE2eApp();
  });

  afterAll(async () => {
    await e2e?.app.close();
  });

  it('REST switch-tenant reaches the fake identity-service; the old access token is denylisted in shared Redis', async () => {
    const owner = await inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'o.sw.gw@example.com', password: PASSWORD, displayName: 'O' },
    });
    const guest = await inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'g.sw.gw@example.com', password: PASSWORD, displayName: 'G' },
    });
    const ownerTenant = owner.json<AuthTokensBody>().tenantId;
    const g = guest.json<AuthTokensBody>();
    e2e.identity.addMembership(ownerTenant, g.user.id, ['member']);

    const res = await inject({
      method: 'POST',
      url: '/v1/auth/switch-tenant',
      headers: { authorization: `Bearer ${g.accessToken}` },
      payload: { tenantId: ownerTenant, refreshToken: g.refreshToken },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<AuthTokensBody>()).toMatchObject({
      tenantId: ownerTenant,
      tenantRoles: ['member'],
    });
    expect(e2e.identity.calls).toContain('AuthService.SwitchTenant');
    const old = await inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${g.accessToken}` },
    });
    expect(old.statusCode).toBe(401);
  });
});

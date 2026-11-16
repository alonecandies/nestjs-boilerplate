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
  user: { id: string };
}
const PASSWORD = 'correct horse battery staple';

describe('staff switch-in through the gateway (fake identity-service)', () => {
  let e2e: GatewayE2e;
  const inject = (...args: Parameters<GatewayE2e['app']['inject']>) => e2e.app.inject(...args);

  beforeAll(async () => {
    e2e = await createGatewayE2eApp();
  });

  afterAll(async () => {
    await e2e?.app.close();
  });

  it('switch-in through the gateway: a staff token for the tenant and an audit row in identity', async () => {
    const owner = await inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'o.staff.gw@example.com', password: PASSWORD, displayName: 'O' },
    });
    const support = await inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 's.staff.gw@example.com', password: PASSWORD, displayName: 'S' },
    });
    const tenantId = owner.json<AuthTokensBody>().tenantId;
    const s = support.json<AuthTokensBody>();
    e2e.identity.grantStaff(s.user.id);

    const res = await inject({
      method: 'POST',
      url: `/v1/staff/tenants/${tenantId}/switch-in`,
      headers: { authorization: `Bearer ${s.accessToken}` },
      payload: { reason: 'ticket #7' },
    });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json<{ accessToken: string; auditEventId: string }>();
    expect(e2e.identity.auditEvents).toContainEqual(
      expect.objectContaining({ id: body.auditEventId, tenantId, type: 'staff.switch_in' }),
    );
    const me = await inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${body.accessToken}` },
    });
    expect(me.json()).toMatchObject({ tenantId, staff: true, tenantRoles: ['admin'] });
  });
});

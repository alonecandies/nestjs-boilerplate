/*
 * Switch tenant through the monolith's real handlers over the in-memory identity store (spec §5.2).
 */
await vi.hoisted(async () => {
  const { MONOLITH_E2E_ENV } = await import('./support/e2e-env.js');
  Object.assign(process.env, MONOLITH_E2E_ENV);
});

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bearer, graphql } from './support/http.js';
import { createMonolithE2eApp, type MonolithE2e } from './support/monolith-e2e-app.js';

interface AuthTokensBody {
  accessToken: string;
  refreshToken: string;
  tenantId: string;
  tenantRoles: string[];
  user: { id: string };
}
const PASSWORD = 'correct horse battery staple';

describe('switch tenant (monolith)', () => {
  let e2e: MonolithE2e;
  const inject = (...args: Parameters<MonolithE2e['app']['inject']>) => e2e.app.inject(...args);
  const register = async (email: string): Promise<AuthTokensBody> => {
    const res = await inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email, password: PASSWORD, displayName: 'X' },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<AuthTokensBody>();
  };
  const join = (tenantId: string, userId: string, roles: ('owner' | 'admin' | 'member')[]) =>
    e2e.identity.store.memberships.set(`${tenantId}:${userId}`, {
      tenantId,
      userId,
      roles,
      lastActiveAt: null,
      createdAt: new Date(),
    });

  beforeAll(async () => {
    e2e = await createMonolithE2eApp();
  });

  afterAll(async () => {
    await e2e?.app.close();
  });

  it('REST: switches into a membership; the old access token is revoked, the old refresh token is spent', async () => {
    const owner = await register('owner.switch@example.com');
    const guest = await register('guest.switch@example.com');
    join(owner.tenantId, guest.user.id, ['admin']);

    const res = await inject({
      method: 'POST',
      url: '/v1/auth/switch-tenant',
      headers: bearer(guest.accessToken),
      payload: { tenantId: owner.tenantId, refreshToken: guest.refreshToken },
    });
    expect(res.statusCode, res.body).toBe(200);
    const switched = res.json<AuthTokensBody>();
    expect(switched).toMatchObject({ tenantId: owner.tenantId, tenantRoles: ['admin'] });

    const me = await inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: bearer(switched.accessToken),
    });
    expect(me.json()).toMatchObject({ tenantId: owner.tenantId, tenantRoles: ['admin'] });
    const old = await inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: bearer(guest.accessToken),
    });
    expect(old.statusCode).toBe(401);
    expect(old.json<{ code: string }>().code).toBe('TOKEN_REVOKED');

    const refreshed = await inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: switched.refreshToken },
    });
    expect(refreshed.json<AuthTokensBody>().tenantId).toBe(owner.tenantId);

    // The pre-switch refresh token was rotated away: presenting it again is reuse (every session revoked).
    const reused = await inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: guest.refreshToken },
    });
    expect(reused.statusCode).toBe(401);
    expect(reused.json<{ code: string }>().code).toBe('REFRESH_TOKEN_REUSED');
  });

  it.each([
    ['a tenant the caller is not a member of', 'foreign'],
    ['the platform tenant', '00000000-0000-0000-0000-000000000000'],
    ['an unknown tenant', '0190f3b2-0000-7000-8000-00000000dead'],
  ])(
    'switch to %s → 403 TENANT_ACCESS_DENIED and both tokens keep working (Review Focus 1)',
    async (_name, which) => {
      const victim = await register(`victim.sw.${which.slice(0, 6)}@example.com`);
      const caller = await register(`caller.sw.${which.slice(0, 6)}@example.com`);
      const res = await inject({
        method: 'POST',
        url: '/v1/auth/switch-tenant',
        headers: bearer(caller.accessToken),
        payload: {
          tenantId: which === 'foreign' ? victim.tenantId : which,
          refreshToken: caller.refreshToken,
        },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json<{ code: string }>().code).toBe('TENANT_ACCESS_DENIED');
      expect(
        (await inject({ method: 'GET', url: '/v1/auth/me', headers: bearer(caller.accessToken) }))
          .statusCode,
      ).toBe(200);
      const refreshed = await inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        payload: { refreshToken: caller.refreshToken },
      });
      expect(refreshed.statusCode).toBe(200);
    },
  );

  it('GraphQL switchTenant returns the AuthPayload of the target tenant', async () => {
    const a = await register('a.gql.switch@example.com');
    const b = await register('b.gql.switch@example.com');
    join(b.tenantId, a.user.id, ['member']);
    const res = await inject(
      graphql(
        'mutation ($input: SwitchTenantInput!) { switchTenant(input: $input) { tenantId tenantRoles } }',
        { input: { tenantId: b.tenantId, refreshToken: a.refreshToken } },
        bearer(a.accessToken),
      ),
    );
    expect(res.json()).toEqual({
      data: { switchTenant: { tenantId: b.tenantId, tenantRoles: ['MEMBER'] } },
    });
  });
});

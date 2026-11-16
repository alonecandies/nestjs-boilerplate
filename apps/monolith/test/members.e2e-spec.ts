import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMonolithE2eApp, type MonolithE2e } from './support/monolith-e2e-app.js';

await vi.hoisted(async () => {
  const { MONOLITH_E2E_ENV } = await import('./support/e2e-env.js');
  Object.assign(process.env, MONOLITH_E2E_ENV);
});

interface Tokens {
  accessToken: string;
  refreshToken: string;
  tenantId: string;
  user: { id: string };
}
const PASSWORD = 'correct horse battery staple';

describe('member endpoints (monolith, B2-13)', () => {
  let e2e: MonolithE2e;
  let ada: Tokens;
  let bob: Tokens;
  let bobInAda: Tokens;
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const register = async (email: string, displayName: string): Promise<Tokens> => {
    const res = await e2e.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email, password: PASSWORD, displayName },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<Tokens>();
  };

  beforeAll(async () => {
    e2e = await createMonolithE2eApp();
    ada = await register('ada.members@example.com', 'Ada');
    bob = await register('bob.members@example.com', 'Bob');
    await e2e.identity.memberships.insert({
      tenantId: ada.tenantId,
      userId: bob.user.id,
      roles: ['member'],
      lastActiveAt: null,
    });
  });

  afterAll(async () => {
    await e2e?.app.close();
  });

  it('GET /v1/tenant/members lists both members', async () => {
    const res = await e2e.app.inject({
      method: 'GET',
      url: '/v1/tenant/members',
      headers: auth(ada.accessToken),
    });
    expect(res.statusCode, res.body).toBe(200);
    const page = res.json<{
      items: { userId: string; roles: string[] }[];
      nextCursor: string | null;
    }>();
    expect(page.items.map((m) => m.userId).sort()).toEqual([ada.user.id, bob.user.id].sort());
    expect(page.nextCursor).toBeNull();
  });

  it('PATCH promotes Bob to admin; the sole owner cannot demote herself (422 LAST_OWNER)', async () => {
    const ok = await e2e.app.inject({
      method: 'PATCH',
      url: `/v1/tenant/members/${bob.user.id}`,
      headers: auth(ada.accessToken),
      payload: { roles: ['admin'] },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ userId: bob.user.id, roles: ['admin'] });

    const last = await e2e.app.inject({
      method: 'PATCH',
      url: `/v1/tenant/members/${ada.user.id}`,
      headers: auth(ada.accessToken),
      payload: { roles: ['member'] },
    });
    expect(last.statusCode, last.body).toBe(422);
    expect(last.json()).toMatchObject({ code: 'LAST_OWNER' });
  });

  it('an admin cannot remove an owner (403 OWNER_RANK_REQUIRED)', async () => {
    const login = await e2e.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'bob.members@example.com', password: PASSWORD, tenantId: ada.tenantId },
    });
    expect(login.statusCode, login.body).toBe(200);
    bobInAda = login.json<Tokens>();
    const res = await e2e.app.inject({
      method: 'DELETE',
      url: `/v1/tenant/members/${ada.user.id}`,
      headers: auth(bobInAda.accessToken),
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json()).toMatchObject({ code: 'OWNER_RANK_REQUIRED' });
  });

  it('POST /v1/tenant/leave is 204 and the leaver refresh token then fails with MEMBERSHIP_REVOKED', async () => {
    const left = await e2e.app.inject({
      method: 'POST',
      url: '/v1/tenant/leave',
      headers: auth(bobInAda.accessToken),
    });
    expect(left.statusCode, left.body).toBe(204);

    const refresh = await e2e.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: bobInAda.refreshToken },
    });
    expect(refresh.statusCode, refresh.body).toBe(401);
    expect(refresh.json()).toMatchObject({ code: 'MEMBERSHIP_REVOKED' });
  });

  it('PATCH with a malformed user id is 400', async () => {
    const res = await e2e.app.inject({
      method: 'PATCH',
      url: '/v1/tenant/members/not-a-uuid',
      headers: auth(ada.accessToken),
      payload: { roles: ['member'] },
    });
    expect(res.statusCode).toBe(400);
  });
});

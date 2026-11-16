import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMonolithE2eApp, type MonolithE2e } from './support/monolith-e2e-app.js';

await vi.hoisted(async () => {
  const { MONOLITH_E2E_ENV } = await import('./support/e2e-env.js');
  Object.assign(process.env, MONOLITH_E2E_ENV);
});

interface Tokens {
  accessToken: string;
  tenantId: string;
  user: { id: string };
}
const PASSWORD = 'correct horse battery staple';

describe('tenant endpoints (monolith, B2-12)', () => {
  let e2e: MonolithE2e;
  let ada: Tokens;
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    e2e = await createMonolithE2eApp();
    const res = await e2e.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'ada.tenants@example.com', password: PASSWORD, displayName: 'Ada' },
    });
    ada = res.json<Tokens>();
  });

  afterAll(async () => {
    await e2e?.app.close();
  });

  it('GET /v1/tenants lists the personal workspace; POST creates one with me as owner', async () => {
    const before = await e2e.app.inject({
      method: 'GET',
      url: '/v1/tenants',
      headers: auth(ada.accessToken),
    });
    expect(before.statusCode, before.body).toBe(200);
    expect(before.json()).toEqual([
      expect.objectContaining({ id: ada.tenantId, personal: true, roles: ['owner'] }),
    ]);

    const created = await e2e.app.inject({
      method: 'POST',
      url: '/v1/tenants',
      headers: auth(ada.accessToken),
      payload: { name: 'Acme' },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({ name: 'Acme', personal: false, roles: ['owner'] });

    const after = await e2e.app.inject({
      method: 'GET',
      url: '/v1/tenants',
      headers: auth(ada.accessToken),
    });
    expect(after.json<unknown[]>()).toHaveLength(2);
  });

  it('PATCH /v1/tenant renames the active tenant for its owner; 400 for a blank name', async () => {
    const ok = await e2e.app.inject({
      method: 'PATCH',
      url: '/v1/tenant',
      headers: auth(ada.accessToken),
      payload: { name: 'Ada Labs' },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ id: ada.tenantId, name: 'Ada Labs' });

    const blank = await e2e.app.inject({
      method: 'PATCH',
      url: '/v1/tenant',
      headers: auth(ada.accessToken),
      payload: { name: '   ' },
    });
    expect(blank.statusCode).toBe(400);
  });

  it('PATCH /v1/tenant is 403 for a member (no tenant:manage)', async () => {
    const bob = await e2e.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'bob.tenants@example.com', password: PASSWORD, displayName: 'Bob' },
    });
    const bobId = bob.json<Tokens>().user.id;
    await e2e.identity.memberships.insert({
      tenantId: ada.tenantId,
      userId: bobId,
      roles: ['member'],
      lastActiveAt: null,
    });
    const login = await e2e.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'bob.tenants@example.com', password: PASSWORD, tenantId: ada.tenantId },
    });
    expect(login.statusCode, login.body).toBe(200);

    const res = await e2e.app.inject({
      method: 'PATCH',
      url: '/v1/tenant',
      headers: auth(login.json<Tokens>().accessToken),
      payload: { name: 'Bob was here' },
    });
    expect(res.statusCode).toBe(403);
  });
});

/*
 * Tenancy through the monolith's real handlers over the in-memory identity store (spec §13: register →
 * personal tenant; tenant-bound sessions; login with a tenant).
 */
await vi.hoisted(async () => {
  const { MONOLITH_E2E_ENV } = await import('./support/e2e-env.js');
  Object.assign(process.env, MONOLITH_E2E_ENV);
});

import { isUuidV7 } from '@platform/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMonolithE2eApp, type MonolithE2e } from './support/monolith-e2e-app.js';

interface AuthTokensBody {
  accessToken: string;
  refreshToken: string;
  tenantId: string;
  tenantRoles: string[];
  user: { id: string; email: string };
}

const PASSWORD = 'correct horse battery staple';

describe('tenancy: workspaces and tenant-bound sessions (monolith)', () => {
  let e2e: MonolithE2e;
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

  beforeAll(async () => {
    e2e = await createMonolithE2eApp();
  });

  afterAll(async () => {
    await e2e?.app.close();
  });

  it('POST /v1/auth/register creates a personal workspace owned by the new user', async () => {
    const ada = await register('ada.tenancy@example.com', 'Ada');
    const owned = [...e2e.identity.store.memberships.values()].filter(
      (m) => m.userId === ada.user.id,
    );
    expect(owned).toEqual([
      expect.objectContaining({ roles: ['owner'], lastActiveAt: expect.any(Date) }),
    ]);
    expect(e2e.identity.store.tenants.get(owned[0]?.tenantId ?? '')).toMatchObject({
      name: "Ada's workspace",
      personal: true,
      slug: expect.stringMatching(/^ada-tenancy-[0-9a-f]{8}$/),
    });
  });

  it('registers "+++@x.io" and two "ada@…" accounts without a 409 (slug inputs, Review Focus 3)', async () => {
    await register('+++@x.io', 'Plus');
    await register('ada@a.io', 'Ada A');
    await register('ada@b.io', 'Ada B');
    const slugs = [...e2e.identity.store.tenants.values()].map((tenant) => tenant.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('register returns the workspace as the token pair tenant; refresh keeps it', async () => {
    const grace = await register('grace.sessions@example.com', 'Grace');
    expect(isUuidV7(grace.tenantId)).toBe(true);
    expect(grace.tenantRoles).toEqual(['owner']);
    const refreshed = await inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: grace.refreshToken },
    });
    expect(refreshed.statusCode, refreshed.body).toBe(200);
    expect(refreshed.json<AuthTokensBody>()).toMatchObject({
      tenantId: grace.tenantId,
      tenantRoles: ['owner'],
    });
  });

  it('refresh after the membership was removed → 401 MEMBERSHIP_REVOKED and the session is revoked', async () => {
    const alan = await register('alan.sessions@example.com', 'Alan');
    e2e.identity.store.memberships.delete(`${alan.tenantId}:${alan.user.id}`);
    const refreshed = await inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: alan.refreshToken },
    });
    expect(refreshed.statusCode).toBe(401);
    expect(refreshed.json<{ code: string }>().code).toBe('MEMBERSHIP_REVOKED');
    const again = await inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: alan.refreshToken },
    });
    expect(again.json<{ code: string }>().code).toBe('REFRESH_TOKEN_REUSED');
  });

  it('login lands in the most recently active membership; an account without one gets a workspace', async () => {
    const linus = await register('linus.sessions@example.com', 'Linus');
    for (const key of [...e2e.identity.store.memberships.keys()]) {
      if (key.endsWith(`:${linus.user.id}`)) e2e.identity.store.memberships.delete(key);
    }
    const login = await inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'linus.sessions@example.com', password: PASSWORD },
    });
    expect(login.statusCode, login.body).toBe(200);
    const body = login.json<AuthTokensBody>();
    expect(body.tenantId).not.toBe(linus.tenantId);
    expect(e2e.identity.store.tenants.get(body.tenantId)).toMatchObject({ personal: true });
  });
});

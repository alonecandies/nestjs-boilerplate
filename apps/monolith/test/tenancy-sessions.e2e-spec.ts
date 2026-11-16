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
import { graphql } from './support/http.js';
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

  it('login with tenantId opens the session in that membership (REST and GraphQL)', async () => {
    const owner = await register('owner.login@example.com', 'Owner');
    const guest = await register('guest.login@example.com', 'Guest');
    // guest joins owner's workspace as a member (B2-13/B2-14 add the API for this).
    e2e.identity.store.memberships.set(`${owner.tenantId}:${guest.user.id}`, {
      tenantId: owner.tenantId,
      userId: guest.user.id,
      roles: ['member'],
      lastActiveAt: null,
      createdAt: new Date(),
    });

    const rest = await inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'guest.login@example.com', password: PASSWORD, tenantId: owner.tenantId },
    });
    expect(rest.statusCode, rest.body).toBe(200);
    expect(rest.json<AuthTokensBody>()).toMatchObject({
      tenantId: owner.tenantId,
      tenantRoles: ['member'],
    });

    const gql = await inject(
      graphql('mutation ($input: LoginInput!) { login(input: $input) { tenantId tenantRoles } }', {
        input: { email: 'guest.login@example.com', password: PASSWORD, tenantId: guest.tenantId },
      }),
    );
    expect(gql.json()).toEqual({
      data: { login: { tenantId: guest.tenantId, tenantRoles: ['OWNER'] } },
    });

    // Without tenantId: the most recently active membership is now guest's own workspace.
    const plain = await inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'guest.login@example.com', password: PASSWORD },
    });
    expect(plain.json<AuthTokensBody>().tenantId).toBe(guest.tenantId);
  });

  it.each([
    ['a tenant the user is not a member of', 'other'],
    ['the platform tenant (nil UUID)', '00000000-0000-0000-0000-000000000000'],
    ['an unknown tenant', '0190f3b2-0000-7000-8000-00000000dead'],
  ])(
    'login with %s → 403 TENANT_ACCESS_DENIED, no session (Review Focus 1)',
    async (_name, which) => {
      const victim = await register(`victim.${which.slice(0, 5)}@example.com`, 'Victim');
      const caller = await register(`caller.${which.slice(0, 5)}@example.com`, 'Caller');
      const sessionsBefore = e2e.identity.store.sessions.size;
      const res = await inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: {
          email: `caller.${which.slice(0, 5)}@example.com`,
          password: PASSWORD,
          tenantId: which === 'other' ? victim.tenantId : which,
        },
      });
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json<{ code: string }>().code).toBe('TENANT_ACCESS_DENIED');
      expect(e2e.identity.store.sessions.size).toBe(sessionsBefore);
      expect(caller.tenantId).not.toBe(victim.tenantId);
    },
  );

  it('login with a malformed tenantId → 400 (REST); a wrong password with a foreign tenant → 401, not 403', async () => {
    const res = await inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'ada.tenancy@example.com', password: PASSWORD, tenantId: 'x' },
    });
    expect(res.statusCode).toBe(400);
    const wrong = await inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        email: 'ada.tenancy@example.com',
        password: 'wrong password',
        tenantId: '0190f3b2-0000-7000-8000-00000000dead',
      },
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json<{ code: string }>().code).toBe('INVALID_CREDENTIALS');
  });

  it('the access token carries tid and the tenant roles; GET /v1/auth/me shows them', async () => {
    const tok = await register('tok.tenancy@example.com', 'Tok');
    const [, payload] = tok.accessToken.split('.');
    const claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    expect(claims).toMatchObject({ sub: tok.user.id, tid: tok.tenantId, roles: ['owner'] });
    expect(claims).not.toHaveProperty('staff');
    const me = await inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${tok.accessToken}` },
    });
    expect(me.statusCode, me.body).toBe(200);
    expect(me.json()).toMatchObject({
      id: tok.user.id,
      email: 'tok.tenancy@example.com',
      tenantId: tok.tenantId,
      tenantRoles: ['owner'],
      staff: false,
    });
  });

  it("the user directory shows the active tenant's members only; other users are 404", async () => {
    const boss = await register('boss.dir@example.com', 'Boss');
    const peer = await register('peer.dir@example.com', 'Peer');
    const stranger = await register('stranger.dir@example.com', 'Stranger');
    e2e.identity.store.memberships.set(`${boss.tenantId}:${peer.user.id}`, {
      tenantId: boss.tenantId,
      userId: peer.user.id,
      roles: ['member'],
      lastActiveAt: null,
      createdAt: new Date(),
    });
    const auth = { authorization: `Bearer ${boss.accessToken}` };

    const list = await inject({ method: 'GET', url: '/v1/users?limit=100', headers: auth });
    expect(list.statusCode, list.body).toBe(200);
    const ids = list.json<{ items: { id: string }[] }>().items.map((user) => user.id);
    expect(ids.sort()).toEqual([boss.user.id, peer.user.id].sort());

    const one = await inject({ method: 'GET', url: `/v1/users/${peer.user.id}`, headers: auth });
    expect(one.statusCode).toBe(200);
    const hidden = await inject({
      method: 'GET',
      url: `/v1/users/${stranger.user.id}`,
      headers: auth,
    });
    expect(hidden.statusCode).toBe(404);

    const gql = await inject(graphql('{ users(limit: 100) { items { id } } }', undefined, auth));
    const gqlIds = gql
      .json<{ data: { users: { items: { id: string }[] } } }>()
      .data.users.items.map((u) => u.id);
    expect(gqlIds.sort()).toEqual([boss.user.id, peer.user.id].sort());
  });
});

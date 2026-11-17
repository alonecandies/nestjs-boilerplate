/*
 * Cross-tenant isolation at the REST and GraphQL edge (monolith, B4-7). Three users, two tenants,
 * and the hard case in every store: U owns tenant A and is an admin of tenant B, W owns B, V is an
 * admin of A only. Fixtures go through the real flows (register, invite, accept, login, switch),
 * never hand-signed tokens.
 *
 * Where each store's proof lives: Postgres payments, the real-Citus journeys of B3 Task 19 (here
 * the edge wiring: the fake Postgres answers by the bound tenant and the spec asserts every
 * executed payments statement named the token's tenant); the Cassandra inbox, the int specs of
 * B4 Tasks 3 and 4 (here the real handlers over the in-memory repositories); storage, the real
 * `FilesService` over `InMemoryStorageService`; the user cache, the real `AppCacheService` L1 tier.
 */
await vi.hoisted(async () => {
  const { MONOLITH_E2E_ENV } = await import('./support/e2e-env.js');
  Object.assign(process.env, MONOLITH_E2E_ENV);
});

import { PaymentStatus, payments } from '@domain/billing';
import { CreateNotificationCommand } from '@domain/notifications';
import { CommandBus } from '@nestjs/cqrs';
import { generateId } from '@platform/common';
import { getTableColumns } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FakeRows } from './support/fake-infrastructure.js';
import { bearer, expectProblem, graphql, multipartFile } from './support/http.js';
import { createMonolithE2eApp, type MonolithE2e } from './support/monolith-e2e-app.js';

interface Tokens {
  accessToken: string;
  refreshToken: string;
  tenantId: string;
  tenantRoles: string[];
  user: { id: string; email: string };
}
interface StoredPayment {
  id: string;
  tenantId: string;
  userId: string;
}

const PASSWORD = 'correct horse battery staple';
const AT = '2026-09-01T10:00:00.000Z';
const U_EMAIL = 'ursula.isolation@example.com';
const V_EMAIL = 'victor.isolation@example.com';
const W_EMAIL = 'wendy.isolation@example.com';

describe('tenant isolation (monolith, B4-7)', () => {
  let e2e: MonolithE2e;
  /** What the fake Postgres holds in `billing.payments` (set once the tenants exist). */
  const stored: StoredPayment[] = [];
  let tenantA = '';
  let tenantB = '';
  let u: Tokens; // U's registration: personal workspace A
  let v: Tokens;
  let w: Tokens; // W's registration: personal workspace B
  let uA: Tokens; // U acting in A
  let uB: Tokens; // U acting in B
  let vA: Tokens; // V acting in A
  let wB: Tokens; // W acting in B

  const post = async (url: string, payload: unknown, token?: string): Promise<Tokens> => {
    const res = await e2e.app.inject({
      method: 'POST',
      url,
      payload: payload as Record<string, unknown>,
      ...(token === undefined ? {} : { headers: bearer(token) }),
    });
    expect(res.statusCode, res.body).toBeLessThan(300);
    return res.json<Tokens>();
  };
  const register = (email: string) =>
    post('/v1/auth/register', { email, password: PASSWORD, displayName: email.split('@')[0] });
  /** Spends `session`'s access token (denylisted) and returns the tokens of `tenantId`. */
  const switchTo = (session: Tokens, tenantId: string) =>
    post(
      '/v1/auth/switch-tenant',
      { tenantId, refreshToken: session.refreshToken },
      session.accessToken,
    );
  /** A fresh session (its own refresh token) acting in `tenantId`: login lands in the last active one. */
  const sessionIn = async (email: string, tenantId: string): Promise<Tokens> => {
    const session = await post('/v1/auth/login', { email, password: PASSWORD });
    return session.tenantId === tenantId ? session : switchTo(session, tenantId);
  };
  /** The raw token of the last invitation mail queued for `email`. */
  const mailedToken = (email: string): string => {
    type InvitationJob = { to?: string; context?: { token?: unknown } };
    const job = [...e2e.mailQueue.jobs]
      .reverse()
      .find((j) => j.name === 'tenant-invitation' && (j.data as InvitationJob).to === email);
    return String((job?.data as InvitationJob | undefined)?.context?.token);
  };
  /** `inviter` invites `invitee` (registered as `invitee`) as an admin and the invitee accepts. */
  const makeAdmin = async (inviter: Tokens, invitee: Tokens): Promise<void> => {
    await post(
      '/v1/tenant/invitations',
      { email: invitee.user.email, roles: ['admin'] },
      inviter.accessToken,
    );
    await post(
      '/v1/invitations/accept',
      { token: mailedToken(invitee.user.email) },
      invitee.accessToken,
    );
  };

  const get = (url: string, token: string) =>
    e2e.app.inject({ method: 'GET', url, headers: bearer(token) });
  const notificationIds = async (token: string): Promise<string[]> => {
    const res = await get('/v1/notifications?limit=50', token);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ items: { id: string }[] }>().items.map((n) => n.id);
  };
  const notificationRead = (id: string): boolean | undefined =>
    e2e.notifications.all().find((n) => n.id === id)?.read;
  const paymentIds = async (url: string, token: string): Promise<string[]> => {
    const res = await get(url, token);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ items: { id: string }[] }>().items.map((p) => p.id);
  };
  const upload = async (token: string, filename: string) => {
    const file = multipartFile(filename, 'text/plain', 'isolation');
    const res = await e2e.app.inject({
      method: 'POST',
      url: '/v1/files',
      headers: { ...file.headers, ...bearer(token) },
      payload: file.payload,
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ key: string }>().key;
  };
  const downloadUrl = (key: string, token: string) =>
    get(`/v1/files/download-url?key=${encodeURIComponent(key)}`, token);
  const remove = (key: string, token: string) =>
    e2e.app.inject({
      method: 'DELETE',
      url: `/v1/files?key=${encodeURIComponent(key)}`,
      headers: bearer(token),
    });

  /** A `billing.payments` row as postgres.js returns it. */
  const paymentRow = ({ id, tenantId, userId }: StoredPayment): FakeRows[number] => {
    const values: Record<string, unknown> = {
      tenantId,
      id,
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

  beforeAll(async () => {
    e2e = await createMonolithE2eApp({
      // Answers a listing by the tenant (and, for an own listing, the user) it was bound with.
      postgresRows: (sql, params) => {
        if (!sql.startsWith('select') || !sql.includes('"billing"."payments"')) return [];
        const tenantId = params.find((p) => p === tenantA || p === tenantB);
        const userId = params.find((p) => stored.some((s) => s.userId === p));
        return stored
          .filter((p) => p.tenantId === tenantId && (userId === undefined || p.userId === userId))
          .map(paymentRow);
      },
    });
    u = await register(U_EMAIL);
    v = await register(V_EMAIL);
    w = await register(W_EMAIL);
    tenantA = u.tenantId;
    tenantB = w.tenantId;
    await makeAdmin(u, v); // V: admin of A only
    await makeAdmin(w, u); // U: admin of B
    uA = await sessionIn(U_EMAIL, tenantA);
    uB = await sessionIn(U_EMAIL, tenantB);
    vA = await sessionIn(V_EMAIL, tenantA);
    wB = await sessionIn(W_EMAIL, tenantB);
    expect(uA).toMatchObject({ tenantId: tenantA, tenantRoles: ['owner'] });
    expect(uB).toMatchObject({ tenantId: tenantB, tenantRoles: ['admin'] });
    expect(vA).toMatchObject({ tenantId: tenantA, tenantRoles: ['admin'] });
    expect(wB).toMatchObject({ tenantId: tenantB, tenantRoles: ['owner'] });
  });

  afterAll(async () => {
    await e2e?.app.close();
  });

  it('notifications: each (tenant, user) inbox holds only its own, over REST and GraphQL', async () => {
    const commandBus = e2e.app.get(CommandBus);
    const create = (tenantId: string, userId: string, title: string) =>
      commandBus.execute(
        new CreateNotificationCommand({ tenantId, userId, type: 'system', title, body: title }),
      );
    const n1 = await create(tenantA, u.user.id, 'n1');
    const n2 = await create(tenantB, u.user.id, 'n2');
    const n3 = await create(tenantA, v.user.id, 'n3');

    expect(await notificationIds(uA.accessToken)).toEqual([n1.id]);
    const viaGraphql = await e2e.app.inject(
      graphql('{ notifications(limit: 50) { items { id } } }', undefined, bearer(uA.accessToken)),
    );
    expect(viaGraphql.statusCode, viaGraphql.body).toBe(200);
    expect(viaGraphql.json<{ errors?: unknown }>().errors).toBeUndefined();
    expect(
      viaGraphql
        .json<{ data: { notifications: { items: { id: string }[] } } }>()
        .data.notifications.items.map((n) => n.id),
    ).toEqual([n1.id]);
    expect(await notificationIds(vA.accessToken)).toEqual([n3.id]);

    // n2 lives in B's inbox of U: A's token cannot see it, so it cannot mark it either.
    const mark = await e2e.app.inject({
      method: 'POST',
      url: `/v1/notifications/${n2.id}/read`,
      headers: bearer(uA.accessToken),
    });
    expectProblem(mark, 404);
    expect(notificationRead(n2.id)).toBe(false);
    expect(await notificationIds(uB.accessToken)).toEqual([n2.id]);

    // A tenant switch re-keys the inbox, and the switched-away token is revoked.
    const session = await sessionIn(U_EMAIL, tenantA);
    expect(await notificationIds(session.accessToken)).toEqual([n1.id]);
    const inB = await switchTo(session, tenantB);
    expect(await notificationIds(inB.accessToken)).toEqual([n2.id]);
    expectProblem(await get('/v1/notifications', session.accessToken), 401, 'TOKEN_REVOKED');
  });

  it('files: keys carry the tenant, and a key is reachable only in its own tenant', async () => {
    const key = await upload(uA.accessToken, 'f.txt');
    expect(key.startsWith(`tenants/${tenantA}/users/${u.user.id}/`)).toBe(true);

    // U's own token for B: the key is another tenant's (and U is an admin there, files:manage).
    expectProblem(await downloadUrl(key, uB.accessToken), 403, 'FILE_ACCESS_DENIED');
    expectProblem(await remove(key, uB.accessToken), 403, 'FILE_ACCESS_DENIED');
    expect(e2e.storage.getObject(key)).toBeDefined();
    // W owns B, so holds files:manage there; still not A's.
    expectProblem(await downloadUrl(key, wB.accessToken), 403, 'FILE_ACCESS_DENIED');
    expectProblem(await remove(key, wB.accessToken), 403, 'FILE_ACCESS_DENIED');
    expect(e2e.storage.getObject(key)).toBeDefined();
    // V is an admin of A: files:manage inside the tenant.
    const viaManage = await downloadUrl(key, vA.accessToken);
    expect(viaManage.statusCode, viaManage.body).toBe(200);

    // A pre-B4 key `users/<uid>/…` is unreachable for everyone, its owner included.
    const legacy = `users/${u.user.id}/x`;
    await e2e.storage.upload({
      key: legacy,
      body: Buffer.from('legacy'),
      contentType: 'text/plain',
    });
    expectProblem(await downloadUrl(legacy, uA.accessToken), 403, 'FILE_ACCESS_DENIED');
    expectProblem(await downloadUrl(legacy, vA.accessToken), 403, 'FILE_ACCESS_DENIED');
    expect(e2e.storage.getObject(legacy)).toBeDefined();
  });

  it('payments: every statement binds the token’s tenant; all=true stays inside it', async () => {
    const p1 = { id: generateId(), tenantId: tenantA, userId: u.user.id };
    const p2 = { id: generateId(), tenantId: tenantB, userId: u.user.id };
    const p3 = { id: generateId(), tenantId: tenantA, userId: v.user.id };
    stored.push(p1, p2, p3);

    /** Runs `fn` and returns the payments statements it executed. */
    const statementsOf = async (fn: () => Promise<void>) => {
      const before = e2e.postgres.queries.length;
      await fn();
      return e2e.postgres.queries
        .slice(before)
        .filter(({ sql }) => sql.startsWith('select') && sql.includes('"billing"."payments"'));
    };
    const expectBoundTo = (
      statements: { params: unknown[] }[],
      tenantId: string,
      otherTenantId: string,
    ) => {
      expect(statements.length).toBeGreaterThan(0);
      for (const { params } of statements) {
        expect(params).toContain(tenantId);
        expect(params).not.toContain(otherTenantId);
      }
    };

    let own: string[] = [];
    expectBoundTo(
      await statementsOf(async () => {
        own = await paymentIds('/v1/billing/payments', uA.accessToken);
      }),
      tenantA,
      tenantB,
    );
    expect(own).toEqual([p1.id]);

    let all: string[] = [];
    expectBoundTo(
      await statementsOf(async () => {
        all = await paymentIds('/v1/billing/payments?all=true', vA.accessToken);
      }),
      tenantA,
      tenantB,
    );
    expect([...all].sort()).toEqual([p1.id, p3.id].sort());

    let inB: string[] = [];
    expectBoundTo(
      await statementsOf(async () => {
        inB = await paymentIds('/v1/billing/payments', uB.accessToken);
      }),
      tenantB,
      tenantA,
    );
    expect(inB).toEqual([p2.id]);
    expect(inB).not.toContain(p1.id);
  });

  it('user cache: a cached profile is not readable from a tenant the user is not in', async () => {
    const read = (id: string, token: string) => get(`/v1/users/${id}`, token);
    // V reads U inside A twice (the second read may come from the cache) and reads self (cached).
    expect((await read(u.user.id, vA.accessToken)).statusCode).toBe(200);
    expect((await read(u.user.id, vA.accessToken)).statusCode).toBe(200);
    expect((await read(v.user.id, vA.accessToken)).statusCode).toBe(200);
    // W acts in B, where V is no member: 404 although V's profile is cached for A.
    expectProblem(await read(v.user.id, wB.accessToken), 404);
    // U acting in B reads W, a member there.
    const inB = await read(w.user.id, uB.accessToken);
    expect(inB.statusCode, inB.body).toBe(200);
    expect(inB.json<{ id: string }>().id).toBe(w.user.id);
  });
});

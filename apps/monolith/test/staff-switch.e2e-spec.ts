/*
 * Platform-staff switch-in through the monolith's real handlers over the in-memory identity store
 * (spec §5.2, §13: staff switch-in and its audit row).
 */
await vi.hoisted(async () => {
  const { MONOLITH_E2E_ENV } = await import('./support/e2e-env.js');
  Object.assign(process.env, MONOLITH_E2E_ENV);
});

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bearer } from './support/http.js';
import { createMonolithE2eApp, type MonolithE2e } from './support/monolith-e2e-app.js';

interface AuthTokensBody {
  accessToken: string;
  refreshToken: string;
  tenantId: string;
  user: { id: string };
}
const PASSWORD = 'correct horse battery staple';

describe('staff switch-in (monolith)', () => {
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
  const setStaff = (userId: string, isPlatformStaff: boolean) => {
    const row = e2e.identity.store.users.get(userId);
    if (row === undefined) throw new Error(`user ${userId} missing`);
    e2e.identity.store.users.set(userId, { ...row, isPlatformStaff });
  };

  beforeAll(async () => {
    e2e = await createMonolithE2eApp();
  });

  afterAll(async () => {
    await e2e?.app.close();
  });

  it('a staff user enters a tenant: admin + staff token, no refresh token, a staff.switch_in audit row', async () => {
    const owner = await register('owner.staff@example.com');
    const support = await register('support.staff@example.com');
    setStaff(support.user.id, true);

    const res = await inject({
      method: 'POST',
      url: `/v1/staff/tenants/${owner.tenantId}/switch-in`,
      headers: bearer(support.accessToken),
      payload: { reason: 'ticket #42' },
    });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json<{
      accessToken: string;
      expiresIn: number;
      tenantId: string;
      auditEventId: string;
    }>();
    expect(body).toMatchObject({ tenantId: owner.tenantId, expiresIn: 900 });
    expect(body).not.toHaveProperty('refreshToken');

    const me = await inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: bearer(body.accessToken),
    });
    expect(me.json()).toMatchObject({
      id: support.user.id,
      tenantId: owner.tenantId,
      tenantRoles: ['admin'],
      staff: true,
    });
    expect(e2e.identity.store.auditEvents).toContainEqual(
      expect.objectContaining({
        id: body.auditEventId,
        tenantId: owner.tenantId,
        actorId: support.user.id,
        type: 'staff.switch_in',
        data: expect.objectContaining({ reason: 'ticket #42' }),
      }),
    );

    // A switch-in token is no refresh token (typ: access, other secret) (Review Focus 5).
    const asRefresh = await inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: body.accessToken },
    });
    expect(asRefresh.statusCode).toBe(401);
    expect(asRefresh.json<{ code: string }>().code).toBe('INVALID_REFRESH_TOKEN');

    // A switch-in token cannot switch tenant (Review Focus 5).
    const sw = await inject({
      method: 'POST',
      url: '/v1/auth/switch-tenant',
      headers: bearer(body.accessToken),
      payload: { tenantId: support.tenantId, refreshToken: support.refreshToken },
    });
    expect(sw.statusCode).toBe(403);
    expect(sw.json<{ code: string }>().code).toBe('STAFF_TOKEN_NOT_ALLOWED');

    // A switch-in token cannot mint its successor, here or in another tenant (spec §5.2).
    const auditRows = e2e.identity.store.auditEvents.length;
    for (const tenantId of [owner.tenantId, support.tenantId]) {
      const again = await inject({
        method: 'POST',
        url: `/v1/staff/tenants/${tenantId}/switch-in`,
        headers: bearer(body.accessToken),
        payload: { reason: 'renew' },
      });
      expect(again.statusCode).toBe(403);
      expect(again.json<{ code: string }>().code).toBe('STAFF_TOKEN_NOT_ALLOWED');
    }
    expect(e2e.identity.store.auditEvents).toHaveLength(auditRows);
  });

  it('403 STAFF_ONLY for a non-staff user and for a flag revoked after login; 404 for the nil tenant', async () => {
    const victim = await register('victim.staff@example.com');
    const nobody = await register('nobody.staff@example.com');
    const denied = await inject({
      method: 'POST',
      url: `/v1/staff/tenants/${victim.tenantId}/switch-in`,
      headers: bearer(nobody.accessToken),
      payload: { reason: 'r' },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json<{ code: string }>().code).toBe('STAFF_ONLY');

    const exStaff = await register('exstaff.staff@example.com');
    const switchIn = () =>
      inject({
        method: 'POST',
        url: `/v1/staff/tenants/${victim.tenantId}/switch-in`,
        headers: bearer(exStaff.accessToken),
        payload: { reason: 'r' },
      });
    setStaff(exStaff.user.id, true);
    expect((await switchIn()).statusCode).toBe(201);
    setStaff(exStaff.user.id, false); // revoked; the same login token is still valid
    const revoked = await switchIn();
    expect(revoked.statusCode).toBe(403);
    expect(revoked.json<{ code: string }>().code).toBe('STAFF_ONLY');

    setStaff(exStaff.user.id, true);
    const nil = await inject({
      method: 'POST',
      url: '/v1/staff/tenants/00000000-0000-0000-0000-000000000000/switch-in',
      headers: bearer(exStaff.accessToken),
      payload: { reason: 'r' },
    });
    expect(nil.statusCode).toBe(404);
  });

  it('switch-out revokes the switch-in token and records staff.switch_out; a normal token gets 403 STAFF_ONLY', async () => {
    const owner = await register('owner.out@example.com');
    const support = await register('support.out@example.com');
    setStaff(support.user.id, true);
    const switched = await inject({
      method: 'POST',
      url: `/v1/staff/tenants/${owner.tenantId}/switch-in`,
      headers: bearer(support.accessToken),
      payload: { reason: 'ticket #9' },
    });
    const staffToken = switched.json<{ accessToken: string }>().accessToken;

    const normal = await inject({
      method: 'POST',
      url: '/v1/staff/switch-out',
      headers: bearer(support.accessToken),
    });
    expect(normal.statusCode).toBe(403);
    expect(normal.json<{ code: string }>().code).toBe('STAFF_ONLY');

    const out = await inject({
      method: 'POST',
      url: '/v1/staff/switch-out',
      headers: bearer(staffToken),
    });
    expect(out.statusCode, out.body).toBe(204);
    const after = await inject({ method: 'GET', url: '/v1/auth/me', headers: bearer(staffToken) });
    expect(after.statusCode).toBe(401);
    expect(after.json<{ code: string }>().code).toBe('TOKEN_REVOKED');
    expect(
      e2e.identity.store.auditEvents
        .filter((event) => event.tenantId === owner.tenantId)
        .map((event) => event.type),
    ).toEqual(['staff.switch_in', 'staff.switch_out']);
    // The staff user's own token still works.
    expect(
      (await inject({ method: 'GET', url: '/v1/auth/me', headers: bearer(support.accessToken) }))
        .statusCode,
    ).toBe(200);
  });
});

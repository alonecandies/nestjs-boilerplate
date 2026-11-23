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
  tenantRoles: string[];
  user: { id: string; email: string };
}
const PASSWORD = 'correct horse battery staple';

describe('tenancy journeys (monolith, B2-28)', () => {
  let e2e: MonolithE2e;
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const register = async (email: string): Promise<Tokens> => {
    const res = await e2e.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email, password: PASSWORD, displayName: email.split('@')[0] },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<Tokens>();
  };
  /** The raw token of the last invitation mail queued for `email`. */
  const mailedToken = (email: string): string => {
    // The recording queue types job data as `unknown`.
    type InvitationJob = { to?: string; context?: { token?: unknown } };
    const job = [...e2e.mailQueue.jobs]
      .reverse()
      .find((j) => j.name === 'tenant-invitation' && (j.data as InvitationJob).to === email);
    return String((job?.data as InvitationJob | undefined)?.context?.token);
  };

  beforeAll(async () => {
    e2e = await createMonolithE2eApp();
  });

  afterAll(async () => {
    await e2e?.app.close();
  });

  it('register creates a personal workspace the token acts in', async () => {
    const ada = await register('ada.journey@example.com');
    expect(ada.tenantRoles).toEqual(['owner']);
    const tenants = await e2e.app.inject({
      method: 'GET',
      url: '/v1/tenants',
      headers: auth(ada.accessToken),
    });
    expect(tenants.json()).toEqual([
      expect.objectContaining({ id: ada.tenantId, personal: true, roles: ['owner'] }),
    ]);
  });

  it('invite → accept → switch: the invitee works in the inviting tenant', async () => {
    const ada = await register('ada.invite@example.com');
    const invite = await e2e.app.inject({
      method: 'POST',
      url: '/v1/tenant/invitations',
      headers: auth(ada.accessToken),
      payload: { email: 'bob.invite@example.com', roles: ['member'] },
    });
    expect(invite.statusCode, invite.body).toBe(201);

    const bob = await register('bob.invite@example.com');
    const accepted = await e2e.app.inject({
      method: 'POST',
      url: '/v1/invitations/accept',
      headers: auth(bob.accessToken),
      payload: { token: mailedToken('bob.invite@example.com') },
    });
    expect(accepted.statusCode, accepted.body).toBe(200);

    const switched = await e2e.app.inject({
      method: 'POST',
      url: '/v1/auth/switch-tenant',
      headers: auth(bob.accessToken),
      payload: { tenantId: ada.tenantId, refreshToken: bob.refreshToken },
    });
    expect(switched.statusCode, switched.body).toBe(200);
    const inAda = switched.json<Tokens>();
    expect(inAda).toMatchObject({ tenantId: ada.tenantId, tenantRoles: ['member'] });

    const members = await e2e.app.inject({
      method: 'GET',
      url: '/v1/tenant/members',
      headers: auth(inAda.accessToken),
    });
    // ARCH-4: a member (no users:read) sees co-members' names, not their emails or roles.
    expect(members.statusCode, members.body).toBe(200);
    type Listed = { userId: string; email: string | null; displayName: string; roles: unknown };
    const listed = new Map(members.json<{ items: Listed[] }>().items.map((m) => [m.userId, m]));
    expect(listed.get(ada.user.id)).toMatchObject({
      email: null,
      displayName: 'ada.invite',
      roles: null,
    });
    expect(listed.get(bob.user.id)).toMatchObject({
      email: 'bob.invite@example.com',
      displayName: 'bob.invite',
      roles: ['member'],
    });
    const asOwner = await e2e.app.inject({
      method: 'GET',
      url: '/v1/tenant/members',
      headers: auth(ada.accessToken),
    });
    expect(
      asOwner
        .json<{ items: Listed[] }>()
        .items.map((m) => [m.email, m.roles])
        .sort(),
    ).toEqual([
      ['ada.invite@example.com', ['owner']],
      ['bob.invite@example.com', ['member']],
    ]);
    const forbidden = await e2e.app.inject({
      method: 'POST',
      url: '/v1/tenant/invitations',
      headers: auth(inAda.accessToken),
      payload: { email: 'eve@example.com', roles: ['member'] },
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it('staff switch-in is audited in the target tenant and cannot touch owners', async () => {
    const ada = await register('ada.staff@example.com');
    const carol = await register('carol.staff@example.com');
    const stored = e2e.identity.store.users.get(carol.user.id);
    if (stored === undefined) throw new Error('carol is not stored');
    e2e.identity.store.users.set(carol.user.id, { ...stored, isPlatformStaff: true });

    const switchIn = await e2e.app.inject({
      method: 'POST',
      url: `/v1/staff/tenants/${ada.tenantId}/switch-in`,
      headers: auth(carol.accessToken),
      payload: { reason: 'Support ticket #42' },
    });
    expect(switchIn.statusCode, switchIn.body).toBe(201);
    const staff = switchIn.json<{ accessToken: string; auditEventId: string }>();
    expect(e2e.identity.store.auditEvents).toContainEqual(
      expect.objectContaining({
        id: staff.auditEventId,
        tenantId: ada.tenantId,
        type: 'staff.switch_in',
      }),
    );

    const list = await e2e.app.inject({
      method: 'GET',
      url: '/v1/tenant/members',
      headers: auth(staff.accessToken),
    });
    expect(list.statusCode).toBe(200);
    const demote = await e2e.app.inject({
      method: 'PATCH',
      url: `/v1/tenant/members/${ada.user.id}`,
      headers: auth(staff.accessToken),
      payload: { roles: ['member'] },
    });
    expect(demote.statusCode).toBe(403);
    expect(demote.json()).toMatchObject({ code: 'OWNER_RANK_REQUIRED' });
  });

  it('the last owner can neither leave nor step down', async () => {
    const ada = await register('ada.owner@example.com');
    const leave = await e2e.app.inject({
      method: 'POST',
      url: '/v1/tenant/leave',
      headers: auth(ada.accessToken),
    });
    expect(leave.statusCode).toBe(422);
    expect(leave.json()).toMatchObject({ code: 'LAST_OWNER' });
    const stepDown = await e2e.app.inject({
      method: 'PATCH',
      url: `/v1/tenant/members/${ada.user.id}`,
      headers: auth(ada.accessToken),
      payload: { roles: ['admin'] },
    });
    expect(stepDown.json()).toMatchObject({ code: 'LAST_OWNER' });
  });
});

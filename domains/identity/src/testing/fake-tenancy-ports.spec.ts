import { createPrincipal, generateId, runWithPrincipal } from '@platform/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeIdentityState } from './fake-identity-ports.js';
import {
  FakeInvitationsPort,
  FakeMembersPort,
  FakeTenancyState,
  FakeTenantsPort,
} from './fake-tenancy-ports.js';

describe('gateway tenancy fakes', () => {
  let identity: FakeIdentityState;
  let state: FakeTenancyState;
  const ada = generateId();
  const bob = generateId();
  const tenantId = generateId();

  beforeEach(() => {
    identity = new FakeIdentityState();
    // Display names differ from the emails, so an email leaking through the name would show.
    for (const [id, email, displayName] of [
      [ada, 'ada@example.com', 'Ada Lovelace'],
      [bob, 'bob@example.com', 'Bob Babbage'],
    ] as const) {
      identity.users.set(id, {
        user: {
          id,
          email,
          displayName,
          roles: [],
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        password: 'x',
      });
    }
    identity.tenants.set(tenantId, { id: tenantId, name: 'Acme', personal: false });
    identity.addMembership(tenantId, ada, ['owner']);
    state = new FakeTenancyState(identity);
  });

  it('create → list mine', async () => {
    const tenants = new FakeTenantsPort(state);
    const created = await tenants.createTenant({ userId: bob, name: 'Bob Co' });
    expect(created.roles).toEqual(['owner']);
    expect((await tenants.listMyTenants({ userId: bob })).items).toHaveLength(1);
  });

  it('invite → accept (email must match, single use) → member', async () => {
    const invitations = new FakeInvitationsPort(state);
    await invitations.createInvitation({
      tenantId,
      actorId: ada,
      email: 'bob@example.com',
      roles: ['member'],
    });
    const token = state.lastTokenFor('bob@example.com');
    expect(token).toEqual(expect.any(String));
    await expect(
      invitations.acceptInvitation({ userId: ada, token: token! }),
    ).rejects.toMatchObject({
      code: 'INVITATION_EMAIL_MISMATCH',
    });
    await expect(
      invitations.acceptInvitation({ userId: bob, token: token! }),
    ).resolves.toMatchObject({ roles: ['member'] });
    expect(identity.membership(tenantId, bob)?.roles).toEqual(['member']);
    await expect(
      invitations.acceptInvitation({ userId: bob, token: token! }),
    ).rejects.toMatchObject({
      code: 'INVITATION_INVALID',
    });
  });

  it('a staff switch-in principal acts with its token roles: members yes, owners never', async () => {
    const members = new FakeMembersPort(state);
    const staff = generateId();
    identity.addMembership(tenantId, bob, ['member']);
    await runWithPrincipal(
      createPrincipal({ userId: staff, tenantId, roles: ['admin'], staff: true }),
      async () => {
        await expect(
          members.updateMemberRoles({ tenantId, actorId: staff, userId: bob, roles: ['admin'] }),
        ).resolves.toMatchObject({ roles: ['admin'] });
        await expect(
          members.updateMemberRoles({ tenantId, actorId: staff, userId: ada, roles: ['member'] }),
        ).rejects.toMatchObject({ code: 'OWNER_RANK_REQUIRED' });
      },
    );
  });

  it('lists co-members without email and roles unless the caller holds users:read (ARCH-4)', async () => {
    const members = new FakeMembersPort(state);
    identity.addMembership(tenantId, bob, ['member']);
    const list = (userId: string, roles: ('owner' | 'admin' | 'member')[] = ['admin']) =>
      runWithPrincipal(createPrincipal({ userId, tenantId, roles }), () =>
        members.listMembers({ tenantId, limit: 0 }),
      );
    // Bob is a member; his token claims admin, but the membership decides.
    const asBob = new Map((await list(bob)).items.map((m) => [m.userId, m]));
    expect(asBob.get(ada)).toMatchObject({ email: '', roles: [], displayName: 'Ada Lovelace' });
    expect(JSON.stringify(asBob.get(ada))).not.toContain('ada@example.com');
    expect(asBob.get(bob)).toMatchObject({ email: 'bob@example.com', roles: ['member'] });
    const asAda = new Map((await list(ada, ['owner'])).items.map((m) => [m.userId, m]));
    expect(asAda.get(bob)).toMatchObject({ email: 'bob@example.com', roles: ['member'] });
  });

  it('protects the last owner', async () => {
    const members = new FakeMembersPort(state);
    await expect(
      members.updateMemberRoles({ tenantId, actorId: ada, userId: ada, roles: ['admin'] }),
    ).rejects.toMatchObject({ code: 'LAST_OWNER' });
    await expect(members.leaveTenant({ tenantId, userId: ada })).rejects.toMatchObject({
      code: 'LAST_OWNER',
    });
  });
});

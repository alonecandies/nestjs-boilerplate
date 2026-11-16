import { createPrincipal, generateId, runWithPrincipal, type TenantRole } from '@platform/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { UserAggregate } from '../../../domain/user.aggregate.js';
import { createInMemoryIdentityPersistence } from '../../../testing/in-memory-identity.js';
import { TenantAuditLog } from '../../services/tenant-audit-log.service.js';
import { UpdateMemberRolesCommand } from './update-member-roles.command.js';
import { UpdateMemberRolesHandler } from './update-member-roles.handler.js';

describe('UpdateMemberRolesHandler', () => {
  let p: ReturnType<typeof createInMemoryIdentityPersistence>;
  let handler: UpdateMemberRolesHandler;
  const tenantId = generateId();
  const [ada, bob, eve] = [generateId(), generateId(), generateId()];

  const member = async (userId: string, roles: TenantRole[]) => {
    // InMemoryUsersRepository.insert takes the aggregate (it stores `user.toSnapshot()`).
    await p.users.insert(
      UserAggregate.register({
        id: userId,
        email: `${userId}@example.com`,
        displayName: `user ${userId.slice(-4)}`,
        passwordHash: 'x',
        now: new Date(),
      }),
    );
    await p.memberships.insert({ tenantId, userId, roles, lastActiveAt: null });
  };
  const as = (actor: string, target: string, roles: string[], staff = false) =>
    runWithPrincipal(
      createPrincipal({ userId: actor, tenantId, roles: staff ? ['admin'] : ['owner'], staff }),
      () => handler.execute(new UpdateMemberRolesCommand(tenantId, actor, target, roles)),
    );

  beforeEach(async () => {
    p = createInMemoryIdentityPersistence();
    await member(ada, ['owner']);
    await member(bob, ['admin']);
    await member(eve, ['member']);
    handler = new UpdateMemberRolesHandler(
      p.memberships,
      p.transactions,
      new TenantAuditLog(p.auditEvents),
    );
  });

  it('an admin promotes a member to admin; audited member.roles_changed', async () => {
    await expect(as(bob, eve, ['admin'])).resolves.toMatchObject({ userId: eve, roles: ['admin'] });
    expect(p.store.auditEvents).toEqual([
      expect.objectContaining({
        type: 'member.roles_changed',
        actorId: bob,
        data: { userId: eve, from: ['member'], to: ['admin'] },
      }),
    ]);
  });

  it('422 LAST_OWNER when the sole owner demotes themself', async () => {
    await expect(as(ada, ada, ['admin'])).rejects.toMatchObject({ code: 'LAST_OWNER' });
    await expect(p.memberships.find(tenantId, ada)).resolves.toMatchObject({ roles: ['owner'] });
  });

  it('an owner may step down once another owner exists', async () => {
    await as(ada, bob, ['owner']);
    await expect(as(ada, ada, ['admin'])).resolves.toMatchObject({ roles: ['admin'] });
  });

  it('403 OWNER_RANK_REQUIRED for an admin touching the owner role (token roles do not matter)', async () => {
    await expect(as(bob, eve, ['owner'])).rejects.toMatchObject({ code: 'OWNER_RANK_REQUIRED' });
    await expect(as(bob, ada, ['member'])).rejects.toMatchObject({ code: 'OWNER_RANK_REQUIRED' });
  });

  it('staff switch-in (admin, no membership) manages members but never owners', async () => {
    const staff = generateId();
    await expect(as(staff, eve, ['admin'], true)).resolves.toMatchObject({ roles: ['admin'] });
    await expect(as(staff, ada, ['member'], true)).rejects.toMatchObject({
      code: 'OWNER_RANK_REQUIRED',
    });
  });

  it('404 for a user who is not a member; 422 INVALID_ROLES for unknown roles', async () => {
    await expect(as(ada, generateId(), ['member'])).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(as(ada, eve, ['root'])).rejects.toMatchObject({ code: 'INVALID_ROLES' });
  });

  it('403 FORBIDDEN for a member', async () => {
    await expect(as(eve, eve, ['admin'])).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

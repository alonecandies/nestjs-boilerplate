import { createPrincipal, generateId, runWithPrincipal, type TenantRole } from '@platform/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { UserAggregate } from '../../../domain/user.aggregate.js';
import { createInMemoryIdentityPersistence } from '../../../testing/in-memory-identity.js';
import { TenantAuditLog } from '../../services/tenant-audit-log.service.js';
import { RemoveMemberCommand } from './remove-member.command.js';
import { RemoveMemberHandler } from './remove-member.handler.js';

describe('RemoveMemberHandler', () => {
  let p: ReturnType<typeof createInMemoryIdentityPersistence>;
  let handler: RemoveMemberHandler;
  const tenantId = generateId();
  const [ada, bob, eve] = [generateId(), generateId(), generateId()];

  const member = async (userId: string, roles: TenantRole[]) => {
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
  const remove = (actor: string, target: string) =>
    runWithPrincipal(createPrincipal({ userId: actor, tenantId, roles: ['owner'] }), () =>
      handler.execute(new RemoveMemberCommand(tenantId, actor, target)),
    );

  beforeEach(async () => {
    p = createInMemoryIdentityPersistence();
    await member(ada, ['owner']);
    await member(bob, ['admin']);
    await member(eve, ['member']);
    handler = new RemoveMemberHandler(
      p.memberships,
      p.transactions,
      new TenantAuditLog(p.auditEvents),
    );
  });

  it('an admin removes a member; audited member.removed', async () => {
    await expect(remove(bob, eve)).resolves.toBeUndefined();
    await expect(p.memberships.find(tenantId, eve)).resolves.toBeNull();
    expect(p.store.auditEvents.at(-1)).toMatchObject({
      type: 'member.removed',
      data: { userId: eve, roles: ['member'] },
    });
  });

  it('403 OWNER_RANK_REQUIRED for an admin removing an owner', async () => {
    await expect(remove(bob, ada)).rejects.toMatchObject({ code: 'OWNER_RANK_REQUIRED' });
  });

  it('422 LAST_OWNER when the sole owner removes themself', async () => {
    await expect(remove(ada, ada)).rejects.toMatchObject({ code: 'LAST_OWNER' });
  });

  it('404 for a user who is not a member', async () => {
    await expect(remove(ada, generateId())).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

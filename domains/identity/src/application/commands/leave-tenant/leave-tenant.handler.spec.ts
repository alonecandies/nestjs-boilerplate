import { createPrincipal, generateId, runWithPrincipal, type TenantRole } from '@platform/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UserAggregate } from '../../../domain/user.aggregate.js';
import { createInMemoryIdentityPersistence } from '../../../testing/in-memory-identity.js';
import { TenantAuditLog } from '../../services/tenant-audit-log.service.js';
import { LeaveTenantCommand } from './leave-tenant.command.js';
import { LeaveTenantHandler } from './leave-tenant.handler.js';

describe('LeaveTenantHandler', () => {
  let p: ReturnType<typeof createInMemoryIdentityPersistence>;
  let handler: LeaveTenantHandler;
  const tenantId = generateId();
  const [ada, eve] = [generateId(), generateId()];

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
  const leave = (userId: string) =>
    runWithPrincipal(createPrincipal({ userId, tenantId, roles: ['owner'] }), () =>
      handler.execute(new LeaveTenantCommand(tenantId, userId)),
    );

  beforeEach(async () => {
    p = createInMemoryIdentityPersistence();
    await member(ada, ['owner']);
    await member(eve, ['member']);
    handler = new LeaveTenantHandler(
      p.memberships,
      p.transactions,
      new TenantAuditLog(p.auditEvents),
    );
  });

  it('a member leaves; audited member.left', async () => {
    await expect(leave(eve)).resolves.toBeUndefined();
    await expect(p.memberships.find(tenantId, eve)).resolves.toBeNull();
    expect(p.store.auditEvents.at(-1)).toMatchObject({
      type: 'member.left',
      actorId: eve,
      data: { roles: ['member'] },
    });
  });

  it('422 LAST_OWNER for the sole owner', async () => {
    await expect(leave(ada)).rejects.toMatchObject({ code: 'LAST_OWNER' });
  });

  it('403 TENANT_ACCESS_DENIED for a staff switch-in principal (no membership to leave)', async () => {
    const staff = generateId();
    await expect(
      runWithPrincipal(
        createPrincipal({ userId: staff, tenantId, roles: ['admin'], staff: true }),
        () => handler.execute(new LeaveTenantCommand(tenantId, staff)),
      ),
    ).rejects.toMatchObject({ code: 'TENANT_ACCESS_DENIED' });
  });

  it('403 TENANT_ACCESS_DENIED when the membership is already gone', async () => {
    await p.memberships.delete(tenantId, eve);
    await expect(leave(eve)).rejects.toMatchObject({ code: 'TENANT_ACCESS_DENIED' });
  });

  it('a DELETE the policies hide (0 rows) is 403 TENANT_ACCESS_DENIED, with no audit row', async () => {
    vi.spyOn(p.memberships, 'delete').mockResolvedValue(false);
    const before = p.store.auditEvents.length;
    await expect(leave(eve)).rejects.toMatchObject({ code: 'TENANT_ACCESS_DENIED' });
    expect(p.store.auditEvents).toHaveLength(before);
  });
});

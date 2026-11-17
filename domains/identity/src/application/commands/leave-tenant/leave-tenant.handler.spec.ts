import { createPrincipal, generateId, runWithPrincipal, type TenantRole } from '@platform/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { recordingEventBus } from '../../../../test/cqrs-fakes.js';
import { MembershipRemovedEvent } from '../../../domain/events/membership-removed.event.js';
import { UserAggregate } from '../../../domain/user.aggregate.js';
import { createInMemoryIdentityPersistence } from '../../../testing/in-memory-identity.js';
import { TenantAuditLog } from '../../services/tenant-audit-log.service.js';
import { LeaveTenantCommand } from './leave-tenant.command.js';
import { LeaveTenantHandler } from './leave-tenant.handler.js';

describe('LeaveTenantHandler', () => {
  let p: ReturnType<typeof createInMemoryIdentityPersistence>;
  let handler: LeaveTenantHandler;
  let events: ReturnType<typeof recordingEventBus>;
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
    events = recordingEventBus();
    handler = new LeaveTenantHandler(
      p.memberships,
      p.transactions,
      new TenantAuditLog(p.auditEvents),
      events.eventBus,
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
    expect(events.published).toHaveLength(1);
    expect(events.published[0]).toBeInstanceOf(MembershipRemovedEvent);
    expect(events.published[0]).toMatchObject({ tenantId, userId: eve, actorId: eve });
  });

  it('422 LAST_OWNER for the sole owner', async () => {
    await expect(leave(ada)).rejects.toMatchObject({ code: 'LAST_OWNER' });
    expect(events.published).toEqual([]);
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
});

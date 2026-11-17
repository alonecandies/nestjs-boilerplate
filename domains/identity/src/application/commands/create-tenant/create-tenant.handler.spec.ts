import { createPrincipal, generateId, runWithPrincipal } from '@platform/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { recordingEventBus } from '../../../../test/cqrs-fakes.js';
import { principalLog } from '../../../../test/principal-log.js';
import { MembershipCreatedEvent } from '../../../domain/events/membership-created.event.js';
import { TENANT_SLUG_PATTERN } from '../../../domain/tenant-slug.js';
import { UserAggregate } from '../../../domain/user.aggregate.js';
import { createInMemoryIdentityPersistence } from '../../../testing/in-memory-identity.js';
import { TenantBootstrap } from '../../services/tenant-bootstrap.elevated.js';
import { CreateTenantCommand } from './create-tenant.command.js';
import { CreateTenantHandler } from './create-tenant.handler.js';

describe('CreateTenantHandler', () => {
  let persistence: ReturnType<typeof createInMemoryIdentityPersistence>;
  let handler: CreateTenantHandler;
  let events: ReturnType<typeof recordingEventBus>;
  let log: ReturnType<typeof principalLog>;
  const userId = generateId();
  const self = createPrincipal({ userId, tenantId: generateId(), roles: ['owner'] });
  const run = (command: CreateTenantCommand) =>
    runWithPrincipal(self, () => handler.execute(command));

  beforeEach(async () => {
    persistence = createInMemoryIdentityPersistence();
    await persistence.users.insert(
      UserAggregate.register({
        id: userId,
        email: 'ada@example.com',
        displayName: 'Ada',
        passwordHash: 'x',
        now: new Date(),
      }),
    );
    events = recordingEventBus();
    log = principalLog();
    const memberships = log.track('memberships', persistence.memberships);
    handler = new CreateTenantHandler(
      memberships,
      persistence.transactions,
      new TenantBootstrap(
        log.track('tenants', persistence.tenants),
        memberships,
        persistence.elevation,
      ),
      log.track('users', persistence.users),
      events.eventBus,
    );
  });

  it('creates a non-personal tenant with the caller as its only owner', async () => {
    const created = await run(new CreateTenantCommand(userId, '  Acme Corp  '));

    expect(created).toMatchObject({
      tenant: { name: 'Acme Corp', personal: false },
      roles: ['owner'],
    });
    expect(created.tenant?.slug).toMatch(TENANT_SLUG_PATTERN);
    expect(created.tenant?.slug).toMatch(/^acme-corp-[0-9a-f]{8}$/);
    await expect(persistence.memberships.find(created.tenant!.id, userId)).resolves.toMatchObject({
      roles: ['owner'],
    });
    expect(events.published).toHaveLength(1);
    expect(events.published[0]).toBeInstanceOf(MembershipCreatedEvent);
    expect(events.published[0]).toMatchObject({
      tenantId: created.tenant!.id,
      userId,
      email: 'ada@example.com',
      displayName: 'Ada',
      actorId: userId,
    });
  });

  it('publishes nothing when the unit of work fails', async () => {
    persistence.memberships.insert = () => Promise.reject(new Error('db down'));
    await expect(run(new CreateTenantCommand(userId, 'Acme'))).rejects.toThrow('db down');
    expect(events.published).toEqual([]);
  });

  it('every write and the read-back run as { user, newTenant, [owner] } (id generated first)', async () => {
    const created = await run(new CreateTenantCommand(userId, 'Acme'));
    const tenantId = created.tenant!.id;
    expect(log.summary()).toEqual([
      // The owner's own row (for the membership event), read as the caller before the unit of work.
      ['users.findById', userId, self.tenantId],
      ['tenants.insert', userId, tenantId],
      ['memberships.insert', userId, tenantId],
      ['memberships.listForUser', userId, tenantId],
    ]);
    expect(log.calls.every((c) => c.principal?.roles.join() === 'owner')).toBe(true);
    expect(persistence.elevation.calls).toEqual([
      { kind: 'justified', name: 'tenant-bootstrap', tenantId },
    ]);
  });

  it.each(['', '   ', 'x'.repeat(101)])(
    'rejects the name %j with VALIDATION_FAILED',
    async (name) => {
      await expect(run(new CreateTenantCommand(userId, name))).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
      expect(persistence.store.tenants.size).toBe(0);
      expect(events.published).toEqual([]);
    },
  );

  it('403 TENANT_ACCESS_DENIED when the request names another user (gRPC cross-check)', async () => {
    await expect(run(new CreateTenantCommand(generateId(), 'Acme'))).rejects.toMatchObject({
      code: 'TENANT_ACCESS_DENIED',
    });
    expect(persistence.store.tenants.size).toBe(0);
  });
});

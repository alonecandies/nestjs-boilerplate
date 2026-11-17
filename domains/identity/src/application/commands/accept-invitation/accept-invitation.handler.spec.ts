import { createPrincipal, generateId, runWithPrincipal } from '@platform/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { recordingEventBus } from '../../../../test/cqrs-fakes.js';
import { MembershipCreatedEvent } from '../../../domain/events/membership-created.event.js';
import { generateInvitationToken, INVITATION_TTL_MS } from '../../../domain/invitation-token.js';
import { UserAggregate } from '../../../domain/user.aggregate.js';
import { createInMemoryIdentityPersistence } from '../../../testing/in-memory-identity.js';
import { TenantAuditLog } from '../../services/tenant-audit-log.service.js';
import { AcceptInvitationCommand } from './accept-invitation.command.js';
import { AcceptInvitationHandler } from './accept-invitation.handler.js';

describe('AcceptInvitationHandler', () => {
  let p: ReturnType<typeof createInMemoryIdentityPersistence>;
  let handler: AcceptInvitationHandler;
  let events: ReturnType<typeof recordingEventBus>;
  const tenantId = generateId();
  const home = generateId();
  const bob = generateId();
  let token: string;

  const accept = (userId: string, raw: string, staff = false) =>
    runWithPrincipal(
      createPrincipal({ userId, tenantId: home, roles: staff ? ['admin'] : ['owner'], staff }),
      () => handler.execute(new AcceptInvitationCommand(userId, raw)),
    );

  const invite = async (email: string, expiresAt = new Date(Date.now() + INVITATION_TTL_MS)) => {
    const generated = generateInvitationToken();
    await p.invitations.insert({
      tenantId,
      id: generateId(),
      email,
      roles: ['admin'],
      tokenHash: generated.tokenHash,
      invitedBy: generateId(),
      expiresAt,
    });
    return generated.token;
  };

  beforeEach(async () => {
    p = createInMemoryIdentityPersistence();
    await p.tenants.insert({
      id: tenantId,
      slug: `acme-${tenantId.slice(-8)}`,
      name: 'Acme',
      personal: false,
    });
    await p.users.insert(
      UserAggregate.register({
        id: bob,
        email: 'bob@example.com',
        displayName: 'Bob',
        passwordHash: 'x',
        now: new Date(),
      }),
    );
    events = recordingEventBus();
    handler = new AcceptInvitationHandler(
      p.invitations,
      p.memberships,
      p.users,
      p.transactions,
      new TenantAuditLog(p.auditEvents),
      events.eventBus,
    );
    token = await invite('bob@example.com');
  });

  it('joins the tenant with the invited roles, once; audited invitation.accepted', async () => {
    await expect(accept(bob, token)).resolves.toMatchObject({
      tenant: { id: tenantId },
      roles: ['admin'],
    });
    await expect(p.memberships.find(tenantId, bob)).resolves.toMatchObject({ roles: ['admin'] });
    expect(p.store.auditEvents.at(-1)).toMatchObject({
      tenantId,
      actorId: bob,
      type: 'invitation.accepted',
    });
    // One membership-created for (the invitation's tenant, the invitee), never the caller's home.
    expect(events.published).toHaveLength(1);
    expect(events.published[0]).toBeInstanceOf(MembershipCreatedEvent);
    expect(events.published[0]).toMatchObject({
      tenantId,
      userId: bob,
      email: 'bob@example.com',
      displayName: 'Bob',
      actorId: bob,
    });
    await expect(accept(bob, token)).rejects.toMatchObject({ code: 'INVITATION_INVALID' });
    expect(events.published).toHaveLength(1);
  });

  it('403 INVITATION_EMAIL_MISMATCH for another account; the invitation stays usable', async () => {
    const eve = generateId();
    await p.users.insert(
      UserAggregate.register({
        id: eve,
        email: 'eve@example.com',
        displayName: 'Eve',
        passwordHash: 'x',
        now: new Date(),
      }),
    );
    await expect(accept(eve, token)).rejects.toMatchObject({ code: 'INVITATION_EMAIL_MISMATCH' });
    await expect(accept(bob, token)).resolves.toBeDefined();
  });

  it('404 INVITATION_INVALID for an expired, unknown or malformed token (indistinguishable)', async () => {
    const expired = await invite('bob@example.com', new Date(Date.now() - 1_000));
    for (const raw of [expired, generateInvitationToken().token, 'not-a-token']) {
      await expect(accept(bob, raw)).rejects.toMatchObject({ code: 'INVITATION_INVALID' });
    }
  });

  it('409 MEMBERSHIP_EXISTS for an existing member; the invitation is not consumed', async () => {
    await p.memberships.insert({ tenantId, userId: bob, roles: ['member'], lastActiveAt: null });
    await expect(accept(bob, token)).rejects.toMatchObject({ code: 'MEMBERSHIP_EXISTS' });
    expect([...p.store.invitations.values()].every((i) => i.acceptedAt === null)).toBe(true);
    expect(events.published).toEqual([]);
  });

  it('a staff switch-in token cannot accept invitations', async () => {
    await expect(accept(bob, token, true)).rejects.toMatchObject({ code: 'TENANT_ACCESS_DENIED' });
  });
});

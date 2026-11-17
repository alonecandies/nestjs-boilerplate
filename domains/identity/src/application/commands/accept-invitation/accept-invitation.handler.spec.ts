import { createPrincipal, generateId, runWithPrincipal } from '@platform/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { principalLog } from '../../../../test/principal-log.js';
import { generateInvitationToken, INVITATION_TTL_MS } from '../../../domain/invitation-token.js';
import { UserAggregate } from '../../../domain/user.aggregate.js';
import { createInMemoryIdentityPersistence } from '../../../testing/in-memory-identity.js';
import { InvitationAcceptance } from '../../services/invitation-acceptance.elevated.js';
import { TenantAuditLog } from '../../services/tenant-audit-log.service.js';
import { AcceptInvitationCommand } from './accept-invitation.command.js';
import { AcceptInvitationHandler } from './accept-invitation.handler.js';

describe('AcceptInvitationHandler', () => {
  let p: ReturnType<typeof createInMemoryIdentityPersistence>;
  let handler: AcceptInvitationHandler;
  let log: ReturnType<typeof principalLog>;
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
    log = principalLog();
    const memberships = log.track('memberships', p.memberships);
    handler = new AcceptInvitationHandler(
      log.track('invitationsSystem', p.invitationsSystem),
      memberships,
      log.track('users', p.users),
      p.transactions,
      new InvitationAcceptance(
        log.track('invitations', p.invitations),
        memberships,
        new TenantAuditLog(log.track('auditEvents', p.auditEvents)),
        p.elevation,
      ),
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
    await expect(accept(bob, token)).rejects.toMatchObject({ code: 'INVITATION_INVALID' });
  });

  it('pre-auth token read, own row as the caller, then the writes as { user, invitation tenant, roles }', async () => {
    await accept(bob, token);
    expect(log.summary()).toEqual([
      ['invitationsSystem.findByTokenHash', bob, home],
      ['users.findById', bob, home],
      ['memberships.find', bob, tenantId],
      ['invitations.markAccepted', bob, tenantId],
      ['memberships.insert', bob, tenantId],
      ['auditEvents.append', bob, tenantId],
      ['memberships.listForUser', bob, tenantId],
    ]);
    expect(log.calls.at(-1)?.principal?.roles).toEqual(['admin']);
    expect(p.elevation.calls).toEqual([
      { kind: 'justified', name: 'verified-invitation', tenantId },
    ]);
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
  });

  it('a staff switch-in token cannot accept invitations', async () => {
    await expect(accept(bob, token, true)).rejects.toMatchObject({ code: 'TENANT_ACCESS_DENIED' });
  });
});

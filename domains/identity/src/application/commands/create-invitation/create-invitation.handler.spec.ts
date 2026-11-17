import { createPrincipal, generateId, runWithPrincipal, type TenantRole } from '@platform/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { principalLog } from '../../../../test/principal-log.js';
import { hashInvitationToken } from '../../../domain/invitation-token.js';
import { createInMemoryIdentityPersistence } from '../../../testing/in-memory-identity.js';
import type { InvitationMailer } from '../../ports/invitation-mailer.port.js';
import { TenantAuditLog } from '../../services/tenant-audit-log.service.js';
import { CreateInvitationCommand } from './create-invitation.command.js';
import { CreateInvitationHandler } from './create-invitation.handler.js';

describe('CreateInvitationHandler', () => {
  let p: ReturnType<typeof createInMemoryIdentityPersistence>;
  let mailer: { send: ReturnType<typeof vi.fn> };
  let handler: CreateInvitationHandler;
  let log: ReturnType<typeof principalLog>;
  const tenantId = generateId();
  const [owner, admin] = [generateId(), generateId()];

  const invite = (actor: string, email: string, roles: string[]) =>
    runWithPrincipal(createPrincipal({ userId: actor, tenantId, roles: ['owner'] }), () =>
      handler.execute(new CreateInvitationCommand(tenantId, actor, email, roles)),
    );

  beforeEach(async () => {
    p = createInMemoryIdentityPersistence();
    await p.tenants.insert({
      id: tenantId,
      slug: `acme-${tenantId.slice(-8)}`,
      name: 'Acme',
      personal: false,
    });
    for (const [userId, roles] of [
      [owner, ['owner']],
      [admin, ['admin']],
    ] as [string, TenantRole[]][]) {
      await p.memberships.insert({ tenantId, userId, roles, lastActiveAt: null });
    }
    mailer = { send: vi.fn().mockResolvedValue(undefined) };
    log = principalLog();
    handler = new CreateInvitationHandler(
      log.track('tenants', p.tenants),
      log.track('memberships', p.memberships),
      log.track('invitations', p.invitations),
      log.track('users', p.users),
      p.transactions,
      new TenantAuditLog(p.auditEvents),
      mailer as unknown as InvitationMailer,
      { appUrl: 'https://app.example.io' },
      log.track('elevation', p.elevation),
    );
  });

  it('stores only the token hash, mails the raw token with the accept link, audits invitation.created', async () => {
    const invitation = await invite(admin, '  New.Person@Example.com ', ['member']);

    expect(invitation).toMatchObject({
      tenantId,
      email: 'new.person@example.com',
      roles: ['member'],
    });
    const [mail] = mailer.send.mock.calls[0] as [
      { to: string; invitationId: string; context: { token: string; acceptUrl: string } },
    ];
    expect(mail.to).toBe('new.person@example.com');
    expect(mail.invitationId).toBe(invitation.id);
    expect(mail.context.acceptUrl).toBe(
      `https://app.example.io/invitations/accept?token=${encodeURIComponent(mail.context.token)}`,
    );
    const stored = [...p.store.invitations.values()][0];
    expect(stored?.tokenHash).toBe(hashInvitationToken(mail.context.token));
    expect(JSON.stringify(stored)).not.toContain(mail.context.token);
    expect(p.store.auditEvents.at(-1)).toMatchObject({
      type: 'invitation.created',
      data: { invitationId: invitation.id, email: 'new.person@example.com', roles: ['member'] },
    });
  });

  it('403 OWNER_RANK_REQUIRED for an admin inviting an owner; nothing stored or mailed', async () => {
    await expect(invite(admin, 'x@example.com', ['owner'])).rejects.toMatchObject({
      code: 'OWNER_RANK_REQUIRED',
    });
    expect(p.store.invitations.size).toBe(0);
    expect(mailer.send).not.toHaveBeenCalled();
  });

  it('acceptUrl is null without MAIL_APP_URL (the mail still carries the token)', async () => {
    handler = new CreateInvitationHandler(
      p.tenants,
      p.memberships,
      p.invitations,
      p.users,
      p.transactions,
      new TenantAuditLog(p.auditEvents),
      mailer as unknown as InvitationMailer,
      { appUrl: undefined },
      p.elevation,
    );
    await invite(owner, 'y@example.com', ['admin']);
    expect(mailer.send.mock.calls[0]?.[0]).toMatchObject({ context: { acceptUrl: null } });
  });
  it('elevates with members:manage first in its unit of work; the mail goes out after COMMIT', async () => {
    await invite(admin, 'x@example.com', ['member']);
    expect(log.calls.map((c) => c.call)).toEqual([
      'memberships.find',
      'elevation.elevate',
      'tenants.findById',
      'invitations.insert',
      'users.findById',
    ]);
    expect(p.elevation.calls).toEqual([{ kind: 'permission', name: 'members:manage', tenantId }]);
    expect(mailer.send).toHaveBeenCalledOnce();
  });
});

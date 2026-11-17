import type { Invitation } from '@domain/identity-contracts';
import { Inject } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { EntityNotFoundException, generateId } from '@platform/common';
import { type MailConfig, mailConfig } from '@platform/config';
import { RlsElevation } from '@platform/database';
import { normalizeEmail } from '../../../domain/email.js';
import { generateInvitationToken, INVITATION_TTL_MS } from '../../../domain/invitation-token.js';
import { assertCanAssignRoles, parseTenantRoles } from '../../../domain/member-roles.policy.js';
import { IdentityPermission } from '../../../identity.permissions.js';
import { toInvitationContract } from '../../mappers/invitation.mapper.js';
import { AUDIT_EVENT_TYPES } from '../../persistence/audit-events.repository.js';
import {
  InvitationsRepository,
  type NewInvitation,
} from '../../persistence/invitations.repository.js';
import { MembershipsRepository } from '../../persistence/memberships.repository.js';
import { TenantsRepository } from '../../persistence/tenants.repository.js';
import { TransactionRunner } from '../../persistence/transaction-runner.js';
import { UsersRepository } from '../../persistence/users.repository.js';
import { InvitationMailer } from '../../ports/invitation-mailer.port.js';
import { actorTenantRoles, requireTenantActor } from '../../services/tenant-actor.js';
import { TenantAuditLog } from '../../services/tenant-audit-log.service.js';
import { CreateInvitationCommand } from './create-invitation.command.js';

@CommandHandler(CreateInvitationCommand)
export class CreateInvitationHandler implements ICommandHandler<CreateInvitationCommand> {
  constructor(
    private readonly tenants: TenantsRepository,
    private readonly memberships: MembershipsRepository,
    private readonly invitations: InvitationsRepository,
    private readonly users: UsersRepository,
    private readonly transactions: TransactionRunner,
    private readonly audit: TenantAuditLog,
    private readonly mailer: InvitationMailer,
    @Inject(mailConfig.KEY) private readonly mail: Pick<MailConfig, 'appUrl'>,
    private readonly elevation: RlsElevation,
  ) {}

  async execute({ tenantId, actorId, email, roles }: CreateInvitationCommand): Promise<Invitation> {
    const principal = requireTenantActor(tenantId, actorId);
    const invitedRoles = parseTenantRoles(roles);
    assertCanAssignRoles(await actorTenantRoles(principal, this.memberships), null, invitedRoles);
    const to = normalizeEmail(email);
    const { token, tokenHash } = generateInvitationToken();
    const now = new Date();
    const record: NewInvitation = {
      tenantId,
      id: generateId(),
      email: to,
      roles: invitedRoles,
      tokenHash,
      invitedBy: actorId,
      expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),
    };
    const tenant = await this.transactions.run(async () => {
      // Route permission MembersManage: elevated (this tenant only) for the whole unit of work.
      await this.elevation.elevate(IdentityPermission.MembersManage);
      const found = await this.tenants.findById(tenantId);
      if (found === null) throw new EntityNotFoundException('Tenant', tenantId);
      await this.invitations.insert(record);
      await this.audit.record({
        tenantId,
        actorId,
        type: AUDIT_EVENT_TYPES.INVITATION_CREATED,
        data: { invitationId: record.id, email: to, roles: invitedRoles },
        now,
      });
      return found;
    });
    const inviter = await this.users.findById(actorId);
    // After COMMIT: a mail never announces an invitation that rolled back.
    await this.mailer.send({
      to,
      invitationId: record.id,
      context: {
        tenantName: tenant.name,
        inviterName: inviter?.displayName ?? 'A workspace admin',
        roles: invitedRoles.join(', '),
        token,
        acceptUrl:
          this.mail.appUrl === undefined
            ? null
            : `${this.mail.appUrl}/invitations/accept?token=${encodeURIComponent(token)}`,
        expiresAt: record.expiresAt.toISOString(),
      },
    });
    return toInvitationContract({ ...record, acceptedAt: null, createdAt: now });
  }
}

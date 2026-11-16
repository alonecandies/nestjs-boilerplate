import type { MyTenant } from '@domain/identity-contracts';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { createPrincipal, requirePrincipal, runWithPrincipal } from '@platform/common';
import { normalizeEmail } from '../../../domain/email.js';
import {
  InvitationEmailMismatchException,
  InvitationInvalidException,
  MembershipAlreadyExistsException,
  TenantAccessDeniedException,
} from '../../../domain/identity.errors.js';
import { hashInvitationToken } from '../../../domain/invitation-token.js';
import { toMyTenantContract } from '../../mappers/tenancy.mapper.js';
import { AUDIT_EVENT_TYPES } from '../../persistence/audit-events.repository.js';
import { InvitationsRepository } from '../../persistence/invitations.repository.js';
import { MembershipsRepository } from '../../persistence/memberships.repository.js';
import { TransactionRunner } from '../../persistence/transaction-runner.js';
import { UsersRepository } from '../../persistence/users.repository.js';
import { TenantAuditLog } from '../../services/tenant-audit-log.service.js';
import { AcceptInvitationCommand } from './accept-invitation.command.js';

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/; // base64url of 32 bytes (INVITATION_TOKEN_BYTES)

@CommandHandler(AcceptInvitationCommand)
export class AcceptInvitationHandler implements ICommandHandler<AcceptInvitationCommand> {
  constructor(
    private readonly invitations: InvitationsRepository,
    private readonly memberships: MembershipsRepository,
    private readonly users: UsersRepository,
    private readonly transactions: TransactionRunner,
    private readonly audit: TenantAuditLog,
  ) {}

  async execute({ userId, token }: AcceptInvitationCommand): Promise<MyTenant> {
    const principal = requirePrincipal();
    if (principal.userId !== userId || principal.staff) throw new TenantAccessDeniedException();
    if (!TOKEN_SHAPE.test(token)) throw new InvitationInvalidException();
    // System read 3 (spec §9): multi-shard on Citus; B3-11 moves it to the system repository.
    const invitation = await this.invitations.findByTokenHash(hashInvitationToken(token));
    const now = new Date();
    if (invitation === null || invitation.acceptedAt !== null || invitation.expiresAt <= now) {
      throw new InvitationInvalidException();
    }
    const user = await this.users.findById(userId);
    if (user === null || normalizeEmail(user.email) !== invitation.email) {
      throw new InvitationEmailMismatchException();
    }
    // Spec §9: act as the accepting user in the invitation's tenant (elevation justified by the token).
    await runWithPrincipal(createPrincipal({ userId, tenantId: invitation.tenantId }), () =>
      this.transactions.run(async () => {
        if ((await this.memberships.find(invitation.tenantId, userId)) !== null) {
          throw new MembershipAlreadyExistsException();
        }
        if (!(await this.invitations.markAccepted(invitation.tenantId, invitation.id, now))) {
          throw new InvitationInvalidException(); // a concurrent accept won
        }
        await this.memberships.insert({
          tenantId: invitation.tenantId,
          userId,
          roles: invitation.roles,
          lastActiveAt: null,
        });
        await this.audit.record({
          tenantId: invitation.tenantId,
          actorId: userId,
          type: AUDIT_EVENT_TYPES.INVITATION_ACCEPTED,
          data: { invitationId: invitation.id, roles: [...invitation.roles] },
          now,
        });
      }),
    );
    const joined = (await this.memberships.listForUser(userId)).find(
      (m) => m.tenantId === invitation.tenantId,
    );
    if (joined === undefined) throw new InvitationInvalidException();
    return toMyTenantContract(joined);
  }
}

import type { MyTenant } from '@domain/identity-contracts';
import { CommandHandler, EventBus, type ICommandHandler } from '@nestjs/cqrs';
import { createPrincipal, requirePrincipal, runWithPrincipal } from '@platform/common';
import { normalizeEmail } from '../../../domain/email.js';
import { MembershipCreatedEvent } from '../../../domain/events/membership-created.event.js';
import {
  InvitationEmailMismatchException,
  InvitationInvalidException,
  TenantAccessDeniedException,
} from '../../../domain/identity.errors.js';
import { hashInvitationToken } from '../../../domain/invitation-token.js';
import { toMyTenantContract } from '../../mappers/tenancy.mapper.js';
import { InvitationsSystemRepository } from '../../persistence/invitations.system-repository.js';
import { MembershipsRepository } from '../../persistence/memberships.repository.js';
import { TransactionRunner } from '../../persistence/transaction-runner.js';
import { UsersRepository } from '../../persistence/users.repository.js';
import { InvitationAcceptance } from '../../services/invitation-acceptance.elevated.js';
import { AcceptInvitationCommand } from './accept-invitation.command.js';

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/; // base64url of 32 bytes (INVITATION_TOKEN_BYTES)

/**
 * Accept an invitation (plan B3 Task 12 flow table): `invitations.findByTokenHash` (pre-auth system
 * read: the token names no tenant); as the caller, the own user row and the email match; then ONE
 * unit of work as `{ user, invitation.tenantId, invitation.roles }`: the `verified-invitation`
 * writes (`InvitationAcceptance`) and the read-back of the new membership.
 */
@CommandHandler(AcceptInvitationCommand)
export class AcceptInvitationHandler implements ICommandHandler<AcceptInvitationCommand> {
  constructor(
    private readonly invitationsSystem: InvitationsSystemRepository,
    private readonly memberships: MembershipsRepository,
    private readonly users: UsersRepository,
    private readonly transactions: TransactionRunner,
    private readonly acceptance: InvitationAcceptance,
    private readonly events: EventBus,
  ) {}

  async execute({ userId, token }: AcceptInvitationCommand): Promise<MyTenant> {
    const principal = requirePrincipal();
    if (principal.userId !== userId || principal.staff) throw new TenantAccessDeniedException();
    if (!TOKEN_SHAPE.test(token)) throw new InvitationInvalidException();
    // pre-auth system read (spec §9 method 3): the token names no tenant; multi-shard on Citus.
    const invitation = await this.invitationsSystem.findByTokenHash(hashInvitationToken(token));
    const now = new Date();
    if (invitation === null || invitation.acceptedAt !== null || invitation.expiresAt <= now) {
      throw new InvitationInvalidException();
    }
    // As the caller: its own user row.
    const user = await this.users.findById(userId);
    if (user === null || normalizeEmail(user.email) !== invitation.email) {
      throw new InvitationEmailMismatchException();
    }
    // Spec §9: act as the accepting user in the invitation's tenant (elevation justified by the token).
    const invitee = createPrincipal({
      userId,
      tenantId: invitation.tenantId,
      roles: invitation.roles,
    });
    const joined = await runWithPrincipal(invitee, () =>
      this.transactions.run(async () => {
        await this.acceptance.accept(invitation, userId, now);
        return (await this.memberships.listForUser(userId)).find(
          (m) => m.tenantId === invitation.tenantId,
        );
      }),
    );
    if (joined === undefined) throw new InvitationInvalidException();
    // Committed: the invitee is a member of the invitation's tenant (not the caller's current one).
    this.events.publish(
      new MembershipCreatedEvent({
        tenantId: invitation.tenantId,
        userId,
        email: user.email,
        displayName: user.displayName,
        actorId: userId,
        occurredAt: now,
      }),
    );
    return toMyTenantContract(joined);
  }
}

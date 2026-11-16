import type { Invitation } from '@domain/identity-contracts';
import { Command } from '@nestjs/cqrs';

/**
 * Invites `email` to the actor's tenant with `roles` (members:manage; owner rank to invite an owner).
 * Stores the token hash, audits `invitation.created` and queues the mail with the raw token.
 */
export class CreateInvitationCommand extends Command<Invitation> {
  constructor(
    readonly tenantId: string,
    readonly actorId: string,
    readonly email: string,
    readonly roles: readonly string[],
  ) {
    super();
  }
}

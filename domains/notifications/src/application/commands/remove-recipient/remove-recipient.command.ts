import { Command } from '@nestjs/cqrs';

export interface RemoveRecipientInput {
  /** The envelope tenant of `identity.membership-removed.v1` (`requireEventTenant`). */
  tenantId: string;
  userId: string;
  /** The membership's end: the delete's write timestamp. */
  removedAt: Date;
}

/**
 * Reaction to identity's `membership-removed` event: no more mail for the user in that tenant.
 * Idempotent; an older replayed `membership-created` cannot bring the row back.
 */
export class RemoveRecipientCommand extends Command<void> {
  constructor(readonly input: RemoveRecipientInput) {
    super();
  }
}

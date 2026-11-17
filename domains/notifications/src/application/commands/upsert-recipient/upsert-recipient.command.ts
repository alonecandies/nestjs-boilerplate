import { Command } from '@nestjs/cqrs';

export interface UpsertRecipientInput {
  /** The envelope tenant of `identity.membership-created.v1` (`requireEventTenant`). */
  tenantId: string;
  userId: string;
  email: string;
  displayName: string;
  /** The membership's creation time: the row's write timestamp. */
  createdAt: Date;
}

/**
 * Reaction to identity's `membership-created` event: remembers where to mail the user in that
 * tenant. Idempotent (same values, same write timestamp on a replay).
 */
export class UpsertRecipientCommand extends Command<void> {
  constructor(readonly input: UpsertRecipientInput) {
    super();
  }
}

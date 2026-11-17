import type { Notification } from '@domain/notifications-contracts';
import { Command } from '@nestjs/cqrs';

export interface WelcomeUserInput {
  /** The envelope tenant of `user-registered`: the personal workspace, whose inbox gets the welcome. */
  tenantId: string;
  userId: string;
  email: string;
  displayName: string;
  registeredAt: Date;
}

/**
 * Reaction to identity's `user-registered` event: puts a welcome notification in the inbox and
 * queues the welcome mail to the event's email. Idempotent end to end.
 */
export class WelcomeUserCommand extends Command<Notification> {
  constructor(readonly input: WelcomeUserInput) {
    super();
  }
}

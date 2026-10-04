import type { Notification } from '@app/contracts';
import { Command } from '@nestjs/cqrs';

export interface WelcomeUserInput {
  userId: string;
  email: string;
  displayName: string;
  registeredAt: Date;
}

/**
 * Reaction to identity's `user-registered` event: remembers where to mail the user, puts a
 * welcome notification in the inbox and queues the welcome mail. Idempotent end to end.
 */
export class WelcomeUserCommand extends Command<Notification> {
  constructor(readonly input: WelcomeUserInput) {
    super();
  }
}

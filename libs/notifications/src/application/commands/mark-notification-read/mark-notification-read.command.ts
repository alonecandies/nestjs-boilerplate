import { Command } from '@nestjs/cqrs';

/** Marks one notification of `userId`'s inbox read (idempotent). */
export class MarkNotificationReadCommand extends Command<void> {
  constructor(
    readonly userId: string,
    readonly notificationId: string,
  ) {
    super();
  }
}

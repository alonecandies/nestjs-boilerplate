import { Command } from '@nestjs/cqrs';

/**
 * Marks one notification of the `(tenantId, userId)` inbox read (idempotent). The pair must be the
 * caller principal's own (`requireInboxActor`).
 */
export class MarkNotificationReadCommand extends Command<void> {
  constructor(
    readonly tenantId: string,
    readonly userId: string,
    readonly notificationId: string,
  ) {
    super();
  }
}

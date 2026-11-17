import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { NotificationNotFoundException } from '../../../domain/notification.errors.js';
import { requireInboxActor } from '../../inbox-actor.js';
import { NotificationsRepository } from '../../ports/notifications.repository.js';
import { MarkNotificationReadCommand } from './mark-notification-read.command.js';

/**
 * A conditional single-row update (`UPDATE … IF EXISTS`) instead of load → `markRead()` → save:
 * one round trip, it cannot resurrect an expired row, and marking twice is harmless. The inbox
 * must be the caller's own pair before the repository is touched (403 TENANT_MISMATCH).
 */
@CommandHandler(MarkNotificationReadCommand)
export class MarkNotificationReadHandler implements ICommandHandler<MarkNotificationReadCommand> {
  constructor(private readonly notifications: NotificationsRepository) {}

  async execute({ tenantId, userId, notificationId }: MarkNotificationReadCommand): Promise<void> {
    requireInboxActor(tenantId, userId);
    const found = await this.notifications.markRead(tenantId, userId, notificationId);
    if (!found) throw new NotificationNotFoundException(notificationId);
  }
}

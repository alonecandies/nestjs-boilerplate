import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { NotificationNotFoundException } from '../../../domain/notification.errors.js';
import { NotificationsRepository } from '../../ports/notifications.repository.js';
import { MarkNotificationReadCommand } from './mark-notification-read.command.js';

/**
 * A conditional single-row update (`UPDATE … IF EXISTS`) instead of load → `markRead()` → save:
 * one round trip, it cannot resurrect an expired row, and marking twice is harmless.
 */
@CommandHandler(MarkNotificationReadCommand)
export class MarkNotificationReadHandler implements ICommandHandler<MarkNotificationReadCommand> {
  constructor(private readonly notifications: NotificationsRepository) {}

  async execute({ userId, notificationId }: MarkNotificationReadCommand): Promise<void> {
    const found = await this.notifications.markRead(userId, notificationId);
    if (!found) throw new NotificationNotFoundException(notificationId);
  }
}

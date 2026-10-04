import { Command } from '@nestjs/cqrs';
import type { NotificationProps } from '../../../domain/notification.types.js';

/**
 * Publishes `notifications.notification-created.v1` for a persisted notification. Resolves
 * `true` once the broker acknowledged it, `false` when publishing failed (logged, never thrown).
 */
export class PublishNotificationCreatedCommand extends Command<boolean> {
  constructor(readonly notification: Readonly<NotificationProps>) {
    super();
  }
}

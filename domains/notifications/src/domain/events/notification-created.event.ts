import type { IEvent } from '@nestjs/cqrs';
import type { NotificationProps } from '../notification.types.js';

/**
 * Raised when a notification was persisted in a (tenant, user) inbox. The push is not driven by it:
 * the command that created the notification dispatches `PublishNotificationCreatedCommand` (Kafka
 * `notifications.notification-created.v1`) itself, last, so a failed publish fails that command.
 */
export class NotificationCreatedEvent implements IEvent {
  constructor(readonly notification: Readonly<NotificationProps>) {}
}

import type { IEvent } from '@nestjs/cqrs';
import type { NotificationProps } from '../notification.types.js';

/**
 * Raised when a notification was persisted in a user's inbox. `NotificationsSagas` turns it into
 * `PublishNotificationCreatedCommand` (Kafka `notifications.notification-created.v1`), which the
 * edge consumes to push it over WebSocket and GraphQL subscriptions.
 */
export class NotificationCreatedEvent implements IEvent {
  constructor(readonly notification: Readonly<NotificationProps>) {}
}

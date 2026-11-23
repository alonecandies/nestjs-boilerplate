import { Command } from '@nestjs/cqrs';
import type { NotificationProps } from '../../../domain/notification.types.js';

/**
 * Publishes `notifications.notification-created.v1` for a persisted notification. Resolves once
 * the broker acknowledged it and rejects when publishing failed: the welcome and receipt handlers
 * dispatch it last, so a failure fails the upstream event, which is retried and then
 * dead-lettered (at-least-once; the envelope id is the notification id, so edges deduplicate).
 */
export class PublishNotificationCreatedCommand extends Command<void> {
  constructor(readonly notification: Readonly<NotificationProps>) {
    super();
  }
}

import type { Notification } from '@app/contracts';
import { Command } from '@nestjs/cqrs';
import type { NotificationKind } from '../../../domain/notification.types.js';

export interface CreateNotificationInput {
  userId: string;
  type: NotificationKind;
  title: string;
  body: string;
  data?: Record<string, string>;
  /**
   * Makes the command idempotent: the notification id is derived from `key` and `occurredAt`
   * (the time of the originating fact), so re-running it upserts the same inbox row. Without it
   * a fresh uuidv7 is minted.
   */
  idempotency?: { key: string; occurredAt: Date };
}

/** Adds a notification to a user's inbox and raises `NotificationCreatedEvent`. */
export class CreateNotificationCommand extends Command<Notification> {
  constructor(readonly input: CreateNotificationInput) {
    super();
  }
}

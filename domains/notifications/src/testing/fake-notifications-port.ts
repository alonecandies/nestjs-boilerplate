import type {
  ListNotificationsRequest,
  MarkNotificationReadRequest,
  Notification,
  NotificationPage,
} from '@domain/notifications-contracts';
import { generateId } from '@platform/common';
import { NotificationNotFoundException, NotificationsPort } from '../index.js';

/**
 * The fake notifications-service inbox: a `NotificationsPort` held in memory, bound in place of the
 * gRPC adapter by the gateway e2e suite. It returns the contract shapes and throws the same
 * `NotificationNotFoundException` as the real adapter. `add()` seeds the inbox.
 */
export class FakeNotificationsPort extends NotificationsPort {
  readonly inbox = new Map<string, Notification[]>();

  add(notification: Omit<Notification, 'id' | 'read' | 'createdAt'>): Notification {
    const stored: Notification = {
      ...notification,
      id: generateId(),
      read: false,
      createdAt: new Date(),
    };
    this.inbox.set(stored.userId, [stored, ...(this.inbox.get(stored.userId) ?? [])]);
    return stored;
  }

  async list(input: ListNotificationsRequest): Promise<NotificationPage> {
    return { items: (this.inbox.get(input.userId) ?? []).slice(0, input.limit) };
  }

  async markRead(input: MarkNotificationReadRequest): Promise<void> {
    const notification = this.inbox
      .get(input.userId)
      ?.find((candidate) => candidate.id === input.notificationId);
    if (!notification) throw new NotificationNotFoundException(input.notificationId);
    notification.read = true;
  }
}

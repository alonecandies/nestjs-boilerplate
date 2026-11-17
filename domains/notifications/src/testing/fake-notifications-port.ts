import type {
  ListNotificationsRequest,
  MarkNotificationReadRequest,
  Notification,
  NotificationPage,
} from '@domain/notifications-contracts';
import { generateId } from '@platform/common';
import { NotificationNotFoundException, NotificationsPort } from '../index.js';

/** A request without a tenant names no inbox: its key matches no seeded one. */
const keyOf = (tenantId: string | undefined, userId: string): string =>
  `${tenantId ?? '(no tenant)'}/${userId}`;

/**
 * The fake notifications-service inbox: a `NotificationsPort` held in memory, bound in place of the
 * gRPC adapter by the gateway e2e suite. Like the real service it keeps one inbox per
 * `(tenantId, userId)`: a request reads and marks only the inbox of the pair it names. It returns
 * the contract shapes and throws the same `NotificationNotFoundException` as the real adapter.
 * `add()` seeds an inbox and requires the tenant.
 */
export class FakeNotificationsPort extends NotificationsPort {
  /** Keyed `<tenantId>/<userId>`. */
  readonly inbox = new Map<string, Notification[]>();

  add(notification: Omit<Notification, 'id' | 'read' | 'createdAt'>): Notification {
    const stored: Notification = {
      ...notification,
      id: generateId(),
      read: false,
      createdAt: new Date(),
    };
    const key = keyOf(stored.tenantId, stored.userId);
    this.inbox.set(key, [stored, ...(this.inbox.get(key) ?? [])]);
    return stored;
  }

  async list(input: ListNotificationsRequest): Promise<NotificationPage> {
    return {
      items: (this.inbox.get(keyOf(input.tenantId, input.userId)) ?? []).slice(0, input.limit),
    };
  }

  async markRead(input: MarkNotificationReadRequest): Promise<void> {
    const notification = this.inbox
      .get(keyOf(input.tenantId, input.userId))
      ?.find((candidate) => candidate.id === input.notificationId);
    if (!notification) throw new NotificationNotFoundException(input.notificationId);
    notification.read = true;
  }
}

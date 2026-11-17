import type {
  NotificationsRepository,
  NotificationsSlice,
} from '../application/ports/notifications.repository.js';
import type { NotificationProps } from '../domain/notification.types.js';

const keyOf = (tenantId: string, userId: string): string => `${tenantId}/${userId}`;

const copy = (notification: Readonly<NotificationProps>): NotificationProps => ({
  ...notification,
  data: { ...notification.data },
});

/**
 * `NotificationsRepository` in memory, keyed like the Cassandra table: one inbox per
 * `(tenantId, userId)`, newest id first. Like the adapter, `insert` never overwrites `read` (a
 * re-inserted read notification stays read), `markRead` only touches an existing row of that pair,
 * and a paging state (hex offset) only ever pages the inbox it is replayed on.
 */
export class InMemoryNotificationsRepository implements NotificationsRepository {
  private readonly inboxes = new Map<string, Map<string, NotificationProps>>();

  insert(notification: Readonly<NotificationProps>): Promise<void> {
    const key = keyOf(notification.tenantId, notification.userId);
    const inbox = this.inboxes.get(key) ?? new Map<string, NotificationProps>();
    const existing = inbox.get(notification.id);
    inbox.set(notification.id, { ...copy(notification), read: existing?.read ?? false });
    this.inboxes.set(key, inbox);
    return Promise.resolve();
  }

  listByUser(
    tenantId: string,
    userId: string,
    limit: number,
    pageState?: string,
  ): Promise<NotificationsSlice> {
    const all = this.newestFirst(tenantId, userId);
    const offset = pageState ? Number.parseInt(pageState, 16) : 0;
    const end = offset + Math.max(1, Math.trunc(limit));
    const next = end < all.length ? end.toString(16).padStart(2, '0') : null;
    return Promise.resolve({ items: all.slice(offset, end), pageState: next });
  }

  findRecentByUser(tenantId: string, userId: string, limit: number): Promise<NotificationProps[]> {
    return Promise.resolve(this.newestFirst(tenantId, userId).slice(0, Math.max(0, limit)));
  }

  markRead(tenantId: string, userId: string, notificationId: string): Promise<boolean> {
    const notification = this.inboxes.get(keyOf(tenantId, userId))?.get(notificationId);
    if (notification === undefined) return Promise.resolve(false);
    notification.read = true;
    return Promise.resolve(true);
  }

  /** Every stored notification of every inbox (test assertions). */
  all(): NotificationProps[] {
    return [...this.inboxes.values()].flatMap((inbox) => [...inbox.values()].map(copy));
  }

  private newestFirst(tenantId: string, userId: string): NotificationProps[] {
    const inbox = this.inboxes.get(keyOf(tenantId, userId));
    // uuidv7 ids sort by time: the Cassandra clustering order (notification_id DESC).
    return [...(inbox?.values() ?? [])]
      .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
      .map(copy);
  }
}

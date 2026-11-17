import type { NotificationProps } from '../../domain/notification.types.js';

export interface NotificationsSlice {
  items: NotificationProps[];
  /** Paging state for the next slice; `null` when there is none. */
  pageState: string | null;
}

/**
 * Persistence of the inbox: one partition per (tenant, user), newest first. Every read and write
 * names both, so a user in two tenants has two inboxes that never mix.
 */
export abstract class NotificationsRepository {
  /**
   * Upsert by (tenant, user, id). Never writes `read`, so re-inserting a notification (Kafka
   * redelivery with a derived id) cannot flip an already-read notification back to unread.
   */
  abstract insert(notification: Readonly<NotificationProps>): Promise<void>;

  /** One page of a (tenant, user) inbox, newest first. */
  abstract listByUser(
    tenantId: string,
    userId: string,
    limit: number,
    pageState?: string,
  ): Promise<NotificationsSlice>;

  /** The `limit` newest notifications of a (tenant, user) inbox (read and unread). */
  abstract findRecentByUser(
    tenantId: string,
    userId: string,
    limit: number,
  ): Promise<NotificationProps[]>;

  /** Marks one notification read. Resolves `false` when it is not in the (tenant, user) inbox. */
  abstract markRead(tenantId: string, userId: string, notificationId: string): Promise<boolean>;
}

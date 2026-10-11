import type { NotificationProps } from '../../domain/notification.types.js';

export interface NotificationsSlice {
  items: NotificationProps[];
  /** Paging state for the next slice; `null` when there is none. */
  pageState: string | null;
}

/** Persistence of the inbox (one partition per user, newest first). */
export abstract class NotificationsRepository {
  /**
   * Upsert by (user, id). Never writes `read`, so re-inserting a notification (Kafka redelivery
   * with a derived id) cannot flip an already-read notification back to unread.
   */
  abstract insert(notification: Readonly<NotificationProps>): Promise<void>;

  /** One page of a user's inbox, newest first. */
  abstract listByUser(
    userId: string,
    limit: number,
    pageState?: string,
  ): Promise<NotificationsSlice>;

  /** The `limit` newest notifications of a user (read and unread). */
  abstract findRecentByUser(userId: string, limit: number): Promise<NotificationProps[]>;

  /** Marks one notification read. Resolves `false` when it is not in the user's inbox. */
  abstract markRead(userId: string, notificationId: string): Promise<boolean>;
}

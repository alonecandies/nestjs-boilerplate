/**
 * Where notification mail goes. A local projection of identity's `user-registered` events: the
 * billing `payment-succeeded` event and the daily digest carry only a user id, and asking
 * identity synchronously would couple this service's availability to it.
 */
export interface NotificationRecipient {
  userId: string;
  email: string;
  displayName: string;
  updatedAt: Date;
}

export interface NotificationRecipientsSlice {
  items: NotificationRecipient[];
  pageState: string | null;
}

export abstract class NotificationRecipientsRepository {
  /** Insert or replace (idempotent: replays write the same values). */
  abstract upsert(recipient: NotificationRecipient): Promise<void>;

  abstract findById(userId: string): Promise<NotificationRecipient | null>;

  /** Bounded, paged scan of all recipients (token order) — for batch jobs such as the digest. */
  abstract scan(limit: number, pageState?: string): Promise<NotificationRecipientsSlice>;
}

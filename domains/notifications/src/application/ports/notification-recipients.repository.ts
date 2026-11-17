/**
 * Where notification mail goes, per membership. A local projection of identity's
 * `membership-created` / `membership-removed` events: the billing `payment-succeeded` event and the
 * daily digest carry only a user id, and asking identity synchronously would couple this service's
 * availability to it. One row per `(tenant, user)`, so a user's mail in tenant A never uses the
 * address or the membership of tenant B, and mail stops when the membership ends.
 */
export interface NotificationRecipient {
  tenantId: string;
  userId: string;
  email: string;
  displayName: string;
  /** The membership event's time; also the write timestamp of the row (last write wins). */
  updatedAt: Date;
}

export interface NotificationRecipientsSlice {
  items: NotificationRecipient[];
  pageState: string | null;
}

export abstract class NotificationRecipientsRepository {
  /**
   * Insert or replace the `(tenant, user)` row, stamped with `recipient.updatedAt`: a write stamped
   * no later than an earlier `remove` stays removed, so replays and reordered events converge.
   */
  abstract upsert(recipient: NotificationRecipient): Promise<void>;

  /** The recipient of this user in this tenant, or `null`. Never looks in another tenant. */
  abstract find(tenantId: string, userId: string): Promise<NotificationRecipient | null>;

  /**
   * Deletes the `(tenant, user)` row, stamped with `removedAt` (default now). Idempotent: removing
   * an absent row is a no-op, and a later-stamped `upsert` brings it back.
   */
  abstract remove(tenantId: string, userId: string, removedAt?: Date): Promise<void>;

  /** Bounded, paged scan of all recipients (token order), one item per `(tenant, user)`: batch jobs only. */
  abstract scan(limit: number, pageState?: string): Promise<NotificationRecipientsSlice>;
}

/**
 * Notification kinds. The same list as `NOTIFICATION_TYPES` in `@app/contracts` (the Kafka
 * `notification-created` payload); the mapper asserts both stay equal at compile time. The domain
 * keeps its own copy because it must not depend on wire contracts.
 */
export const NOTIFICATION_KINDS = ['welcome', 'payment_receipt', 'digest', 'system'] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const isNotificationKind = (value: unknown): value is NotificationKind =>
  typeof value === 'string' && (NOTIFICATION_KINDS as readonly string[]).includes(value);

/** State of one inbox entry (one row of `notifications_by_user`). */
export interface NotificationProps {
  /** uuidv7 — its time component orders the inbox (clustering key, newest first). */
  id: string;
  userId: string;
  type: NotificationKind;
  title: string;
  body: string;
  /** Free-form string attributes for clients (deep links, ids). */
  data: Record<string, string>;
  read: boolean;
  createdAt: Date;
}

export type NewNotificationProps = Omit<NotificationProps, 'read'>;

/** Title/body bounds: inbox rows stay small, and push payloads fit comfortably in one frame. */
export const NOTIFICATION_TITLE_MAX_LENGTH = 200;
export const NOTIFICATION_BODY_MAX_LENGTH = 2_000;
export const NOTIFICATION_DATA_MAX_ENTRIES = 20;

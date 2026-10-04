import { isUuidV7, uuidV7Timestamp } from '@app/common';
import { NOTIFICATION_TYPES, type Notification, type NotificationType } from '@app/contracts';

/** A contract notification as every edge renders it (REST, GraphQL, WebSocket). */
export interface NotificationView {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  read: boolean;
  data: Record<string, string>;
  createdAt: Date;
}

const isNotificationType = (value: string): value is NotificationType =>
  (NOTIFICATION_TYPES as readonly string[]).includes(value);

/**
 * Contract → view. The contract's `type` is a free string on the wire and `createdAt` is
 * optional; edges promise clients an enum and a timestamp, so both are normalised here (an
 * unknown type from a newer service renders as `system`).
 */
export function toNotificationView(notification: Notification): NotificationView {
  return {
    id: notification.id,
    type: isNotificationType(notification.type) ? notification.type : 'system',
    title: notification.title,
    body: notification.body,
    read: notification.read,
    data: { ...notification.data },
    createdAt:
      notification.createdAt ??
      (isUuidV7(notification.id) ? uuidV7Timestamp(notification.id) : new Date(0)),
  };
}

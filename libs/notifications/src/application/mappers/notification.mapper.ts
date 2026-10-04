import type {
  Notification,
  NotificationCreatedPayload,
  NotificationPage,
  NotificationType,
} from '@app/contracts';
import type { NotificationKind, NotificationProps } from '../../domain/notification.types.js';
import type { NotificationsSlice } from '../ports/notifications.repository.js';

/**
 * Domain kind ↔ contract type. Both records are exhaustive, so adding a kind on either side
 * without the other fails to compile right here.
 */
const TYPE_BY_KIND: Readonly<Record<NotificationKind, NotificationType>> = {
  welcome: 'welcome',
  payment_receipt: 'payment_receipt',
  digest: 'digest',
  system: 'system',
};

export const KIND_BY_TYPE: Readonly<Record<NotificationType, NotificationKind>> = {
  welcome: 'welcome',
  payment_receipt: 'payment_receipt',
  digest: 'digest',
  system: 'system',
};

/** Domain state → gRPC/port contract (`notifications.v1.Notification`). */
export function toNotificationContract(props: Readonly<NotificationProps>): Notification {
  return {
    id: props.id,
    userId: props.userId,
    type: TYPE_BY_KIND[props.type],
    title: props.title,
    body: props.body,
    read: props.read,
    data: { ...props.data },
    createdAt: props.createdAt,
  };
}

/** Repository slice → contract page (`nextPageState` absent on the last page, as in the proto). */
export function toNotificationPage(slice: NotificationsSlice): NotificationPage {
  const page: NotificationPage = { items: slice.items.map(toNotificationContract) };
  if (slice.pageState) page.nextPageState = slice.pageState;
  return page;
}

/** Domain state → Kafka `notifications.notification-created.v1` payload. */
export function toNotificationCreatedPayload(
  props: Readonly<NotificationProps>,
): NotificationCreatedPayload {
  return {
    notificationId: props.id,
    userId: props.userId,
    type: TYPE_BY_KIND[props.type],
    title: props.title,
    body: props.body,
    data: { ...props.data },
    createdAt: props.createdAt.toISOString(),
  };
}

/** Kafka payload → contract shape (what the edge pushes; a new notification is unread). */
export function notificationFromCreatedPayload(payload: NotificationCreatedPayload): Notification {
  return {
    id: payload.notificationId,
    userId: payload.userId,
    type: payload.type,
    title: payload.title,
    body: payload.body,
    read: false,
    data: { ...payload.data },
    createdAt: new Date(payload.createdAt),
  };
}

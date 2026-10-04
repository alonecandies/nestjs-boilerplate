import { isUuidV7, uuidV7Timestamp } from '@app/common';
import type { Notification, NotificationPage } from '@app/contracts';
import { isEmpty, isNil, isPlainObject, isString, pickBy } from 'lodash-es';

/**
 * What proto-loader (`defaults: true`) actually hands over: absent message fields and absent
 * proto3 `optional` scalars arrive as `null`, not `undefined` as the ts-proto types claim.
 */
type Wire<T> = { [K in keyof T]?: T[K] | null };

export type WireNotification = Wire<Notification>;
export type WireNotificationPage = {
  items?: WireNotification[] | null;
  nextPageState?: string | null;
};

function toDate(value: unknown, id: string): Date | undefined {
  if (value instanceof Date) return value;
  if (isString(value) || typeof value === 'number') return new Date(value);
  // A missing timestamp can be recovered from the uuidv7 id.
  return isUuidV7(id) ? uuidV7Timestamp(id) : undefined;
}

/** Wire notification → the exact shape the local adapter returns. */
export function normalizeNotification(wire: WireNotification): Notification {
  const id = wire.id ?? '';
  const notification: Notification = {
    id,
    userId: wire.userId ?? '',
    type: wire.type ?? 'system',
    title: wire.title ?? '',
    body: wire.body ?? '',
    read: wire.read ?? false,
    // A map field is `{}` when empty, but reject anything that is not a string→string record.
    data: isPlainObject(wire.data) ? pickBy(wire.data, isString) : {},
  };
  const createdAt = toDate(wire.createdAt, id);
  if (!isNil(createdAt)) notification.createdAt = createdAt;
  return notification;
}

/** Wire page → contract page (`nextPageState` omitted on the last page, like the local adapter). */
export function normalizeNotificationPage(
  wire: WireNotificationPage | null | undefined,
): NotificationPage {
  const page: NotificationPage = { items: (wire?.items ?? []).map(normalizeNotification) };
  const next = wire?.nextPageState;
  if (!isNil(next) && !isEmpty(next)) page.nextPageState = next;
  return page;
}

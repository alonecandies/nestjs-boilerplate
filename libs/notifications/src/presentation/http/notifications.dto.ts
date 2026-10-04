import { NOTIFICATION_TYPES, type NotificationPage } from '@app/contracts';
import { z } from 'zod';
import {
  DEFAULT_NOTIFICATIONS_PAGE_SIZE,
  MAX_NOTIFICATIONS_PAGE_SIZE,
  PAGE_STATE_MAX_LENGTH,
  PAGE_STATE_PATTERN,
} from '../../notifications.constants.js';
import { type NotificationView, toNotificationView } from '../notification-view.js';

/**
 * `GET /v1/notifications` query — Nest-native Standard Schema (`@Query({ schema })`). No
 * `.meta({ id })` on query/param objects: Swagger expands them into individual parameters.
 */
export const listNotificationsQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_NOTIFICATIONS_PAGE_SIZE)
    .default(DEFAULT_NOTIFICATIONS_PAGE_SIZE)
    .describe('Page size (newest first).'),
  pageState: z
    .string()
    .max(PAGE_STATE_MAX_LENGTH)
    .regex(PAGE_STATE_PATTERN, 'Must be a nextPageState returned by a previous page')
    .optional()
    .describe('Opaque `nextPageState` of the previous page.'),
});

export type ListNotificationsQueryParams = z.output<typeof listNotificationsQuerySchema>;

export const notificationIdParamSchema = z.uuid();

export const notificationResponseSchema = z
  .object({
    id: z.uuid(),
    type: z.enum(NOTIFICATION_TYPES),
    title: z.string(),
    body: z.string(),
    read: z.boolean(),
    data: z.record(z.string(), z.string()).describe('String attributes (deep links, ids).'),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'Notification', description: 'One entry of the caller’s inbox.' });

export const notificationPageResponseSchema = z
  .object({
    items: z.array(notificationResponseSchema),
    nextPageState: z
      .string()
      .nullable()
      .describe('Pass as `pageState` to get the next page; `null` on the last page.'),
  })
  .meta({ id: 'NotificationPage' });

export type NotificationResponse = z.infer<typeof notificationResponseSchema>;
export type NotificationPageResponse = z.infer<typeof notificationPageResponseSchema>;

export function toNotificationResponse(view: NotificationView): NotificationResponse {
  return { ...view, createdAt: view.createdAt.toISOString() };
}

export function toNotificationPageResponse(page: NotificationPage): NotificationPageResponse {
  return {
    items: page.items.map((item) => toNotificationResponse(toNotificationView(item))),
    nextPageState: page.nextPageState ?? null,
  };
}

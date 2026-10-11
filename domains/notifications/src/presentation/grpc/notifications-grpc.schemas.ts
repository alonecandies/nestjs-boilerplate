import { z } from 'zod';
import {
  MAX_NOTIFICATIONS_PAGE_SIZE,
  PAGE_STATE_MAX_LENGTH,
  PAGE_STATE_PATTERN,
} from '../../notifications.constants.js';

/**
 * ts-proto request types are interfaces, so class-validator would silently skip them
 * (nest-distributed §3.4): payloads are validated with zod via `ZodRpcValidationPipe`, which
 * answers INVALID_ARGUMENT with the issues. proto3 defaults are accepted: `limit` 0 = default page,
 * an absent `page_state` arrives as null or ''.
 */
export const listNotificationsRequestSchema = z.object({
  userId: z.uuid(),
  limit: z.number().int().min(0).max(MAX_NOTIFICATIONS_PAGE_SIZE),
  pageState: z
    .string()
    .max(PAGE_STATE_MAX_LENGTH)
    .nullish()
    .transform((value) => value || undefined)
    .pipe(z.string().regex(PAGE_STATE_PATTERN).optional()),
});

export const markNotificationReadRequestSchema = z.object({
  userId: z.uuid(),
  notificationId: z.uuid(),
});

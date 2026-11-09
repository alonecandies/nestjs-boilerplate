import type { ConfigType } from '@nestjs/config';
import { defineConfigNamespace, zInt } from '@platform/config';
import { z } from 'zod';

export const notificationsRateLimitEnvSchema = z
  .object({
    NOTIFICATIONS_MARK_READ_LIMIT: zInt(30, { min: 1 }),
    NOTIFICATIONS_MARK_READ_TTL_MS: zInt(10_000, { min: 1 }),
  })
  .transform((env) => ({
    markReadLimit: env.NOTIFICATIONS_MARK_READ_LIMIT,
    markReadTtlMs: env.NOTIFICATIONS_MARK_READ_TTL_MS,
  }));

/** Named rate-limit policies of the notifications domain (gateway, monolith). */
export const notificationsRateLimitConfig = defineConfigNamespace(
  'notificationsRateLimit',
  notificationsRateLimitEnvSchema,
);
export type NotificationsRateLimitConfig = ConfigType<typeof notificationsRateLimitConfig>;

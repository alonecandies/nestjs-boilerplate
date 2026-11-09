import { ConfigModule } from '@nestjs/config';
import { RateLimitModule, type RateLimitPolicy } from '@platform/redis';
import {
  type NotificationsRateLimitConfig,
  notificationsRateLimitConfig,
} from './notifications-rate-limit.config.js';

export const NOTIFICATIONS_RATE_LIMITS = { MARK_READ: 'notifications.mark-read' } as const;

export function notificationsRateLimitPolicies(
  cfg: NotificationsRateLimitConfig,
): RateLimitPolicy[] {
  return [
    {
      name: NOTIFICATIONS_RATE_LIMITS.MARK_READ,
      key: 'user',
      limit: cfg.markReadLimit,
      ttlMs: cfg.markReadTtlMs,
    },
  ];
}

export const NotificationsRateLimitModule = RateLimitModule.forFeature({
  imports: [ConfigModule.forFeature(notificationsRateLimitConfig)],
  inject: [notificationsRateLimitConfig.KEY],
  useFactory: notificationsRateLimitPolicies,
});

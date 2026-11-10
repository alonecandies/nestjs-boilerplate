import { RATE_LIMIT_POLICY_KEY } from '@platform/redis';
import { describe, expect, it } from 'vitest';
import { NotificationsGateway } from './notifications.gateway.js';
import { notificationsRateLimitConfig } from './notifications-rate-limit.config.js';
import {
  NOTIFICATIONS_RATE_LIMITS,
  notificationsRateLimitPolicies,
} from './notifications-rate-limit.js';

describe('notifications rate-limit policies', () => {
  it('reads NOTIFICATIONS_MARK_READ_* with the previous 30 per 10 s defaults', () => {
    expect(notificationsRateLimitPolicies(notificationsRateLimitConfig.parse({}))).toEqual([
      { name: 'notifications.mark-read', key: 'user', limit: 30, ttlMs: 10_000 },
    ]);
    const tuned = notificationsRateLimitConfig.parse({
      NOTIFICATIONS_MARK_READ_LIMIT: '5',
      NOTIFICATIONS_MARK_READ_TTL_MS: '1000',
    });
    expect(notificationsRateLimitPolicies(tuned)[0]).toMatchObject({ limit: 5, ttlMs: 1_000 });
  });

  it('markRead uses the notifications.mark-read policy', () => {
    expect(
      Reflect.getMetadata(RATE_LIMIT_POLICY_KEY, NotificationsGateway.prototype.markRead),
    ).toBe(NOTIFICATIONS_RATE_LIMITS.MARK_READ);
  });
});

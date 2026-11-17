import { RATE_LIMIT_POLICY_KEY } from '@platform/redis';
import { describe, expect, it } from 'vitest';
import { NotificationsResolver } from '../graphql/notifications.resolver.js';
import { NotificationsController } from '../http/notifications.controller.js';
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

  it('every mark-read entry point uses the notifications.mark-read policy (Socket.IO, REST, GraphQL)', () => {
    for (const handler of [
      NotificationsGateway.prototype.markRead,
      NotificationsController.prototype.markRead,
      NotificationsResolver.prototype.markNotificationRead,
    ]) {
      expect(Reflect.getMetadata(RATE_LIMIT_POLICY_KEY, handler)).toBe(
        NOTIFICATIONS_RATE_LIMITS.MARK_READ,
      );
    }
  });
});

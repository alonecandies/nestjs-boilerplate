import { redisConfig } from '@platform/config';
import { describe, expect, it, vi } from 'vitest';
import { RedisKeyService } from '../keys/redis-key.service.js';
import { InMemoryRedis } from '../testing/in-memory-redis.js';
import { RateLimitCharger } from './rate-limit-charger.js';
import { rateLimitKey } from './rate-limit-key.util.js';
import { RedisThrottlerStorage } from './redis-throttler.storage.js';

describe('RateLimitCharger', () => {
  it('increments the bucket by weight and returns the IETF decision', async () => {
    const incrementBy = vi.fn(async () => ({
      totalHits: 150,
      timeToExpire: 30,
      isBlocked: false,
      timeToBlockExpire: 0,
    }));
    const charger = new RateLimitCharger({ increment: vi.fn(), incrementBy });
    const bucket = {
      throttler: 'graphql',
      scope: 'cost',
      tracker: 'user:u-1',
      limit: 1_000,
      ttlMs: 60_000,
      blockMs: 60_000,
    };
    const { decision } = await charger.charge(bucket, 50);
    expect(incrementBy).toHaveBeenCalledWith(
      rateLimitKey('graphql', 'cost', 'user:u-1'),
      60_000,
      1_000,
      60_000,
      'graphql',
      50,
    );
    expect(decision).toMatchObject({
      throttler: 'graphql',
      scope: 'cost',
      remaining: 850,
      resetSeconds: 30,
      blocked: false,
    });
  });

  it('falls back to increment() (weight 1) for storages without incrementBy', async () => {
    const increment = vi.fn(async () => ({
      totalHits: 1,
      timeToExpire: 60,
      isBlocked: false,
      timeToBlockExpire: 0,
    }));
    const charger = new RateLimitCharger({ increment });
    await charger.charge(
      { throttler: 'graphql', scope: 'cost', tracker: 't', limit: 5, ttlMs: 1_000, blockMs: 0 },
      7,
    );
    expect(increment).toHaveBeenCalledTimes(1);
  });

  it('admits the charge while Redis is down (the graphql budget fails open)', async () => {
    const redis = new InMemoryRedis();
    const keys = new RedisKeyService(redisConfig.parse({ REDIS_KEY_PREFIX: 'svc' }));
    const charger = new RateLimitCharger(new RedisThrottlerStorage(redis.asRedis(), keys));
    redis.simulateOutage();
    const { record, decision } = await charger.charge(
      {
        throttler: 'graphql',
        scope: 'cost',
        tracker: 'user:u-1',
        limit: 5,
        ttlMs: 1_000,
        blockMs: 1_000,
      },
      50,
    );
    expect(record.isBlocked).toBe(false);
    expect(decision.blocked).toBe(false);
  });

  it('builds trackers like the guards: user first, IPv6 collapsed to the configured subnet', () => {
    const storage = { increment: vi.fn() };
    const byDefault = new RateLimitCharger(storage);
    expect(byDefault.trackerFor({ id: 'u-1' }, '2001:db8::1')).toBe('user:u-1');
    expect(byDefault.trackerFor(undefined, '2001:db8:0:0:aaaa::1')).toBe(
      byDefault.trackerFor(undefined, '2001:db8:0:0:bbbb::2'),
    );
    expect(byDefault.trackerFor(undefined, '2001:db8:0:1::1')).not.toBe(
      byDefault.trackerFor(undefined, '2001:db8:0:0::1'),
    );
    expect(byDefault.trackerFor(undefined, '1.2.3.4')).toBe('ip:1.2.3.4');
    expect(byDefault.trackerFor(undefined, undefined)).toBe('ip:unknown');
    const wide = new RateLimitCharger(storage, { throttlers: [], ipv6SubnetPrefix: 48 });
    expect(wide.trackerFor(undefined, '2001:db8:0:1::1')).toBe(
      wide.trackerFor(undefined, '2001:db8:0:2::1'),
    );
  });
});

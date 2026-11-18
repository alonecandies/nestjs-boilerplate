import { redisConfig } from '@platform/config';
import { register } from 'prom-client';
import { describe, expect, it, vi } from 'vitest';
import { RedisKeyService } from '../keys/redis-key.service.js';
import { InMemoryRedis } from '../testing/in-memory-redis.js';
import { RateLimitCharger } from './rate-limit-charger.js';
import { rateLimitKey } from './rate-limit-key.util.js';
import { RATE_LIMIT_DECISIONS_TOTAL } from './rate-limit-metrics.js';
import { RATE_LIMIT_FAIL_OPEN_TOTAL, RedisThrottlerStorage } from './redis-throttler.storage.js';

type Sample = { labels: Record<string, string | number>; value: number };

/** The value of one series of `name` (0 when the metric or the series is absent). */
async function value(name: string, labels: Record<string, string>): Promise<number> {
  const metric = register.getSingleMetric(name);
  if (metric === undefined) return 0;
  const values = (await metric.get()).values as Sample[];
  const hit = values.find((s) =>
    Object.entries(labels).every(([label, wanted]) => s.labels[label] === wanted),
  );
  return hit?.value ?? 0;
}

const decisions = (scope: string, outcome: 'allowed' | 'blocked') =>
  value(RATE_LIMIT_DECISIONS_TOTAL, { throttler: 'graphql', scope, outcome });

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

  it('counts one decision per charge whatever the weight (G-10)', async () => {
    const incrementBy = vi.fn(async () => ({
      totalHits: 900,
      timeToExpire: 30,
      isBlocked: false,
      timeToBlockExpire: 0,
    }));
    const charger = new RateLimitCharger({ increment: vi.fn(), incrementBy });
    const bucket = {
      throttler: 'graphql',
      scope: 'charger.weight',
      tracker: 'user:u-1',
      limit: 1_000,
      ttlMs: 60_000,
      blockMs: 60_000,
    };
    const allowed = await decisions('charger.weight', 'allowed');
    const blocked = await decisions('charger.weight', 'blocked');
    await charger.charge(bucket, 250);
    expect(await decisions('charger.weight', 'allowed')).toBe(allowed + 1);
    await charger.charge(bucket, 1);
    expect(await decisions('charger.weight', 'allowed')).toBe(allowed + 2);
    incrementBy.mockResolvedValueOnce({
      totalHits: 1_200,
      timeToExpire: 30,
      isBlocked: true,
      timeToBlockExpire: 30,
    });
    await charger.charge(bucket, 300);
    expect(await decisions('charger.weight', 'blocked')).toBe(blocked + 1);
    expect(await decisions('charger.weight', 'allowed')).toBe(allowed + 2);
  });

  it('counts a fail-open charge as allowed and leaves rate_limit_fail_open_total to the storage', async () => {
    const redis = new InMemoryRedis();
    const keys = new RedisKeyService(redisConfig.parse({ REDIS_KEY_PREFIX: 'svc' }));
    const onFailOpen = vi.fn();
    const charger = new RateLimitCharger(
      new RedisThrottlerStorage(redis.asRedis(), keys, { onFailOpen }),
    );
    redis.simulateOutage();
    const failOpenBefore = await value(RATE_LIMIT_FAIL_OPEN_TOTAL, { throttler: 'graphql' });
    const allowed = await decisions('charger.fail-open', 'allowed');
    const blocked = await decisions('charger.fail-open', 'blocked');
    const { decision } = await charger.charge(
      {
        throttler: 'graphql',
        scope: 'charger.fail-open',
        tracker: 'user:u-1',
        limit: 5,
        ttlMs: 1_000,
        blockMs: 1_000,
      },
      50,
    );
    expect(decision.blocked).toBe(false);
    expect(await decisions('charger.fail-open', 'allowed')).toBe(allowed + 1);
    expect(await decisions('charger.fail-open', 'blocked')).toBe(blocked);
    // C5: the storage reports the bypass once (AppThrottlerModule wires it to the counter);
    // the charger neither increments nor registers that counter itself.
    expect(onFailOpen).toHaveBeenCalledTimes(1);
    expect(onFailOpen).toHaveBeenCalledWith('graphql');
    expect(await value(RATE_LIMIT_FAIL_OPEN_TOTAL, { throttler: 'graphql' })).toBe(failOpenBefore);
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

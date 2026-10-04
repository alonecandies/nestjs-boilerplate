import { ServiceUnavailableException } from '@app/common';
import { redisConfig } from '@app/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RedisKeyService } from '../keys/redis-key.service.js';
import { InMemoryRedis } from '../testing/in-memory-redis.js';
import { msToSeconds, RedisThrottlerStorage } from './redis-throttler.storage.js';
import { THROTTLE_COMMAND, THROTTLE_SCRIPT } from './throttle.command.js';

const keys = new RedisKeyService(redisConfig.parse({ REDIS_KEY_PREFIX: 'svc' }));

describe('RedisThrottlerStorage (fixed window + block, script model)', () => {
  let now: number;
  let redis: InMemoryRedis;
  let storage: RedisThrottlerStorage;
  const hit = (limit = 3, ttl = 1_000, block = 5_000) =>
    storage.increment('tracker-hash', ttl, limit, block, 'default');

  beforeEach(() => {
    now = 1_000_000;
    redis = new InMemoryRedis({ now: () => now });
    storage = new RedisThrottlerStorage(redis.asRedis(), keys);
  });

  it('registers the Lua command under a name that cannot collide with redlock', () => {
    expect(THROTTLE_COMMAND).not.toMatch(/^(acquireLock|extendLock|releaseLock)$/);
    expect(THROTTLE_SCRIPT).toContain("redis.call('INCR', KEYS[1])");
    expect(Reflect.get(redis, THROTTLE_COMMAND)).toBeTypeOf('function');
  });

  it('counts hits in one window and reports seconds', async () => {
    await expect(hit()).resolves.toEqual({
      totalHits: 1,
      timeToExpire: 1,
      isBlocked: false,
      timeToBlockExpire: 0,
    });
    now += 400;
    await expect(hit()).resolves.toMatchObject({ totalHits: 2, isBlocked: false });
    await expect(hit()).resolves.toMatchObject({ totalHits: 3, isBlocked: false });
    // The window keeps its original expiry (fixed window, not sliding).
    expect(redis.pttlSync('svc:throttle:{default:tracker-hash}:hits')).toBe(600);
  });

  it('blocks for blockDuration once the limit is exceeded, without counting blocked hits', async () => {
    for (let i = 0; i < 3; i++) await hit();
    await expect(hit()).resolves.toEqual({
      totalHits: 4,
      timeToExpire: 5,
      isBlocked: true,
      timeToBlockExpire: 5,
    });
    now += 2_000; // the hits window is over, the block is not
    await expect(hit()).resolves.toEqual({
      totalHits: 4,
      timeToExpire: 3,
      isBlocked: true,
      timeToBlockExpire: 3,
    });
    now += 3_000; // block lifted → a fresh window starts
    await expect(hit()).resolves.toMatchObject({ totalHits: 1, isBlocked: false });
  });

  it('without blockDuration, rejects until the window resets', async () => {
    for (let i = 0; i < 3; i++) await hit(3, 1_000, 0);
    await expect(hit(3, 1_000, 0)).resolves.toMatchObject({
      totalHits: 4,
      isBlocked: true,
      timeToBlockExpire: 1,
    });
    now += 1_000;
    await expect(hit(3, 1_000, 0)).resolves.toMatchObject({ totalHits: 1, isBlocked: false });
  });

  it('keeps throttlers and trackers apart (hash-tagged keys)', async () => {
    await storage.increment('a', 1_000, 1, 1_000, 'default');
    await expect(storage.increment('a', 1_000, 1, 1_000, 'long')).resolves.toMatchObject({
      totalHits: 1,
      isBlocked: false,
    });
    await expect(storage.increment('b', 1_000, 1, 1_000, 'default')).resolves.toMatchObject({
      totalHits: 1,
    });
    expect(redis.getSync('svc:throttle:{default:a}:hits')).toBe('1');
    expect(redis.getSync('svc:throttle:{long:a}:hits')).toBe('1');
  });

  it('rounds fractional ttl / blockDuration up (PEXPIRE requires integers)', async () => {
    const call = vi.spyOn(redis.asRedis(), 'appThrottleHit');
    await storage.increment('k', 999.2, 5, 10.5, 'default');
    expect(call).toHaveBeenCalledWith(expect.any(String), expect.any(String), 1_000, 5, 11);
  });

  it('fails open while Redis is disconnected (no command queued)', async () => {
    redis.simulateOutage('reconnecting');
    await expect(hit()).resolves.toEqual({
      totalHits: 0,
      timeToExpire: 1,
      isBlocked: false,
      timeToBlockExpire: 0,
    });
    expect(redis.calls).not.toContain(THROTTLE_COMMAND);
  });

  it('fails open when the script call errors', async () => {
    vi.spyOn(redis.asRedis(), 'appThrottleHit').mockRejectedValue(new Error('NOSCRIPT'));
    await expect(hit()).resolves.toMatchObject({ isBlocked: false, totalHits: 0 });
  });

  it('fails closed with 503 when failOpen is false', async () => {
    const strict = new RedisThrottlerStorage(redis.asRedis(), keys, { failOpen: false });
    redis.simulateOutage();
    await expect(strict.increment('k', 1_000, 1, 1_000, 'default')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('msToSeconds rounds up and never goes negative', () => {
    expect(msToSeconds(1)).toBe(1);
    expect(msToSeconds(1_000)).toBe(1);
    expect(msToSeconds(1_001)).toBe(2);
    expect(msToSeconds(-5)).toBe(0);
  });
});

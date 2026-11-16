import { ServiceUnavailableException } from '@platform/common';
import { redisConfig } from '@platform/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RedisKeyService } from '../keys/redis-key.service.js';
import { InMemoryRedis } from '../testing/in-memory-redis.js';
import { msToSeconds, RedisThrottlerStorage } from './redis-throttler.storage.js';
import { THROTTLE_COMMAND, THROTTLE_SCRIPT } from './throttle.command.js';

const keys = new RedisKeyService(redisConfig.parse({ REDIS_KEY_PREFIX: 'svc' }));
const makeStorage = () => new RedisThrottlerStorage(new InMemoryRedis().asRedis(), keys);

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
    expect(THROTTLE_SCRIPT).toContain("redis.call('INCRBY', KEYS[1]");
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
    expect(call).toHaveBeenCalledWith(expect.any(String), expect.any(String), 1_000, 5, 11, 1);
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

it('incrementBy() adds the weight and blocks once the weighted total passes the limit', async () => {
  const storage = makeStorage();
  await expect(
    storage.incrementBy('op', 60_000, 100, 60_000, 'graphql', 60),
  ).resolves.toMatchObject({ totalHits: 60, isBlocked: false });
  await expect(
    storage.incrementBy('op', 60_000, 100, 60_000, 'graphql', 40),
  ).resolves.toMatchObject({ totalHits: 100, isBlocked: false });
  await expect(storage.incrementBy('op', 60_000, 100, 60_000, 'graphql', 1)).resolves.toMatchObject(
    { isBlocked: true },
  );
  await expect(storage.increment('one', 60_000, 1, 0, 'user')).resolves.toMatchObject({
    totalHits: 1,
  });
});

describe('RedisThrottlerStorage.reset and the lockout boundary', () => {
  it('admits exactly THRESHOLD attempts, refuses the next one, and reset() restarts the count', async () => {
    const storage = makeStorage();
    const attempt = () => storage.increment('acct', 900_000, 3, 900_000, 'lockout');
    for (const hits of [1, 2, 3]) {
      await expect(attempt()).resolves.toMatchObject({ totalHits: hits, isBlocked: false });
    }
    await storage.reset('acct', 'lockout'); // a correct password on the 3rd attempt
    await expect(attempt()).resolves.toMatchObject({ totalHits: 1, isBlocked: false });
    await attempt();
    await attempt();
    await expect(attempt()).resolves.toMatchObject({ isBlocked: true }); // 4th after 3 failures
  });

  it('reset() clears the hit counter of one bucket only', async () => {
    const storage = makeStorage();
    await storage.increment('k', 60_000, 5, 60_000, 'lockout');
    await storage.increment('k', 60_000, 5, 60_000, 'lockout');
    await storage.increment('other', 60_000, 5, 60_000, 'lockout');
    await storage.reset('k', 'lockout');
    await expect(storage.increment('k', 60_000, 5, 60_000, 'lockout')).resolves.toMatchObject({
      totalHits: 1,
    });
    await expect(storage.increment('other', 60_000, 5, 60_000, 'lockout')).resolves.toMatchObject({
      totalHits: 2,
    });
  });
});

describe('Redis down (C-10)', () => {
  it('fails open for budgets and closed (503) for auth and lockout by default', async () => {
    const redis = new InMemoryRedis();
    const onFailOpen = vi.fn();
    const storage = new RedisThrottlerStorage(redis.asRedis(), keys, { onFailOpen });
    redis.simulateOutage();
    for (const name of ['ip', 'user', 'route', 'tenant']) {
      await expect(storage.increment('k', 1_000, 1, 1_000, name)).resolves.toMatchObject({
        isBlocked: false,
      });
    }
    expect(onFailOpen.mock.calls.map(([name]) => name)).toEqual(['ip', 'user', 'route', 'tenant']);
    for (const name of ['auth', 'lockout']) {
      await expect(storage.increment('k', 1_000, 1, 1_000, name)).rejects.toMatchObject({
        code: 'SERVICE_UNAVAILABLE',
      });
    }
  });

  it('bounds a hung (connected) Redis with the command timeout', async () => {
    const redis = new InMemoryRedis();
    const client = redis.asRedis();
    const storage = new RedisThrottlerStorage(client, keys, { commandTimeoutMs: 20 });
    Reflect.set(client, 'appThrottleHit', () => new Promise(() => undefined)); // never settles
    const started = Date.now();
    await expect(storage.increment('k', 1_000, 1, 1_000, 'user')).resolves.toMatchObject({
      isBlocked: false,
    });
    await expect(storage.increment('k', 1_000, 1, 1_000, 'auth')).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('still honours a boolean failOpen for every throttler', async () => {
    const redis = new InMemoryRedis();
    const storage = new RedisThrottlerStorage(redis.asRedis(), keys, { failOpen: true });
    redis.simulateOutage();
    await expect(storage.increment('k', 1_000, 1, 1_000, 'auth')).resolves.toMatchObject({
      isBlocked: false,
    });
  });
});

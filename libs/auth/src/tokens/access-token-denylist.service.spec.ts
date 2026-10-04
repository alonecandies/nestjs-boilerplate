import { ServiceUnavailableException } from '@app/common';
import { authConfig, redisConfig } from '@app/config';
import { RedisKeyService } from '@app/redis';
import { InMemoryRedis } from '@app/redis/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DENYLIST_CHECK_TIMEOUT_MS } from '../auth.constants.js';
import { AccessTokenDenylist } from './access-token-denylist.service.js';

const keys = new RedisKeyService(redisConfig.parse({ REDIS_KEY_PREFIX: 'svc' }));
const enabled = authConfig.parse({ NODE_ENV: 'test' });
const disabled = authConfig.parse({ NODE_ENV: 'test', AUTH_DENYLIST_ENABLED: 'false' });

describe('AccessTokenDenylist', () => {
  let redis: InMemoryRedis;
  const nowSec = (): number => Math.floor(Date.now() / 1_000);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    redis = new InMemoryRedis();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('denies a jti for its remaining lifetime (+ clock tolerance) under the prefixed key', async () => {
    const denylist = new AccessTokenDenylist(redis.asRedis(), keys, enabled);
    await denylist.deny('jti-1', nowSec() + 600);
    await expect(denylist.isDenied('jti-1')).resolves.toBe(true);
    await expect(denylist.isDenied('jti-2')).resolves.toBe(false);
    await expect(redis.ttl('svc:auth:denylist:jti-1')).resolves.toBe(605);

    vi.setSystemTime(Date.now() + 606_000);
    await expect(denylist.isDenied('jti-1')).resolves.toBe(false); // expired with the token
  });

  it('still denies tokens inside the clock-tolerance window, skips hopeless ones', async () => {
    const denylist = new AccessTokenDenylist(redis.asRedis(), keys, enabled);
    await denylist.deny('recent', nowSec() - 2);
    await expect(redis.ttl('svc:auth:denylist:recent')).resolves.toBe(3);
    await denylist.deny('ancient', nowSec() - 60);
    expect(redis.calls.filter((c) => c === 'set')).toHaveLength(1);
  });

  it('is a no-op when AUTH_DENYLIST_ENABLED=false', async () => {
    const denylist = new AccessTokenDenylist(redis.asRedis(), keys, disabled);
    expect(denylist.enabled).toBe(false);
    await denylist.deny('jti-1', nowSec() + 600);
    await expect(denylist.isDenied('jti-1')).resolves.toBe(false);
    expect(redis.calls).toEqual([]);
  });

  it('fails closed (503) when Redis cannot answer', async () => {
    const denylist = new AccessTokenDenylist(redis.asRedis(), keys, enabled);
    redis.simulateOutage();
    await expect(denylist.isDenied('jti-1')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

describe('AccessTokenDenylist while Redis is unreachable but not yet failing', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('fails closed (503) within the timeout instead of waiting in the offline queue', async () => {
    vi.useFakeTimers();
    const redis = new InMemoryRedis();
    // A command parked in ioredis' offline queue (blackholed host): it never settles in time.
    vi.spyOn(redis, 'exists').mockImplementation(() => new Promise<number>(() => undefined));
    const denylist = new AccessTokenDenylist(redis.asRedis(), keys, enabled);

    let settled = false;
    const check = denylist.isDenied('jti-1').finally(() => {
      settled = true;
    });
    const assertion = expect(check).rejects.toBeInstanceOf(ServiceUnavailableException);

    await vi.advanceTimersByTimeAsync(DENYLIST_CHECK_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
  });
});

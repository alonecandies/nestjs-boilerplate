import { redisConfig, throttleConfig } from '@platform/config';
import { describe, expect, it } from 'vitest';
import { RedisKeyService } from '../keys/redis-key.service.js';
import { InMemoryRedis } from '../testing/in-memory-redis.js';
import { ConnectionCaps } from './connection-caps.js';
import { RateLimitCharger } from './rate-limit-charger.js';
import { RedisThrottlerStorage } from './redis-throttler.storage.js';

function setup(env: Record<string, string> = {}) {
  const redis = new InMemoryRedis();
  const keys = new RedisKeyService(redisConfig.parse({}));
  const storage = new RedisThrottlerStorage(redis.asRedis(), keys);
  const caps = new ConnectionCaps(
    redis.asRedis(),
    keys,
    throttleConfig.parse(env),
    new RateLimitCharger(storage),
  );
  return { redis, caps };
}

describe('ConnectionCaps', () => {
  it('caps concurrent sockets per user and frees a slot on release', async () => {
    const { caps } = setup({ THROTTLE_WS_SOCKETS_PER_USER: '2' });
    expect(await caps.acquireSocket('u-1')).toBe(true);
    expect(await caps.acquireSocket('u-1')).toBe(true);
    expect(await caps.acquireSocket('u-1')).toBe(false);
    expect(await caps.acquireSocket('u-2')).toBe(true);
    await caps.releaseSocket('u-1');
    expect(await caps.acquireSocket('u-1')).toBe(true);
  });

  it('never goes below zero on extra releases', async () => {
    const { caps } = setup({ THROTTLE_WS_SOCKETS_PER_USER: '1' });
    await caps.releaseSocket('u-1');
    await caps.releaseSocket('u-1');
    expect(await caps.acquireSocket('u-1')).toBe(true);
    expect(await caps.acquireSocket('u-1')).toBe(false);
  });

  it('limits handshakes per IP with a retry-after', async () => {
    const { caps } = setup({ THROTTLE_WS_HANDSHAKE_LIMIT: '2' });
    expect(await caps.admitHandshake('1.2.3.4')).toEqual({ ok: true });
    expect(await caps.admitHandshake('1.2.3.4')).toEqual({ ok: true });
    const refused = await caps.admitHandshake('1.2.3.4');
    expect(refused.ok).toBe(false);
    expect(await caps.admitHandshake('5.6.7.8')).toEqual({ ok: true });
  });

  it('fails open when Redis is down', async () => {
    const { redis, caps } = setup({
      THROTTLE_WS_SOCKETS_PER_USER: '1',
      THROTTLE_WS_HANDSHAKE_LIMIT: '1',
    });
    redis.simulateOutage();
    expect(await caps.acquireSocket('u-1')).toBe(true);
    expect(await caps.acquireSocket('u-1')).toBe(true);
    expect((await caps.admitHandshake('1.2.3.4')).ok).toBe(true);
    await expect(caps.releaseSocket('u-1')).resolves.toBeUndefined();
  });
});

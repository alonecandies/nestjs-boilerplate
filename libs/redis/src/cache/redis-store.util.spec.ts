import { cacheConfig, redisConfig } from '@app/config';
import { createCache } from 'cache-manager';
import type { Keyv } from 'keyv';
import { describe, expect, it } from 'vitest';
import { createCacheOptions } from './app-cache.module.js';
import { openRedisStores } from './redis-store.util.js';

/** Port 1 refuses connections at once: a Redis outage without any infrastructure. */
const downRedis = (): ReturnType<typeof createCacheOptions> =>
  createCacheOptions(
    cacheConfig.parse({}),
    redisConfig.parse({ REDIS_URL: 'redis://127.0.0.1:1', REDIS_CONNECT_TIMEOUT_MS: '10000' }),
  );

describe('openRedisStores + createCacheOptions (L2 best-effort under a Redis outage)', () => {
  it('opens only the @keyv/redis tier, once', async () => {
    const options = downRedis();
    const cache = createCache({ stores: options.stores as Keyv[], ttl: 1_000 });
    expect(openRedisStores(cache)).toBe(1);
    expect(openRedisStores(cache)).toBe(0); // already open (reconnecting)
    await cache.disconnect();
  });

  it('serves read-through at full speed while L2 is unreachable (no connectionTimeout stall)', async () => {
    const options = downRedis();
    const [, l2] = options.stores as Keyv[];
    const cache = createCache({ stores: options.stores as Keyv[], ttl: 1_000 });
    openRedisStores(cache);

    const startedAt = performance.now();
    for (let i = 0; i < 20; i += 1) {
      await expect(cache.wrap(`k${String(i)}`, async () => i)).resolves.toBe(i);
    }
    // Before: every call waited REDIS_CONNECT_TIMEOUT_MS (10 s) on get AND on set.
    expect(performance.now() - startedAt).toBeLessThan(2_000);
    // L1 still works in front of the dead L2.
    await expect(cache.get('k3')).resolves.toBe(3);
    // No per-call listener re-registration on the node-redis client during the outage.
    if (l2 === undefined) throw new Error('L2 store missing');
    const { client } = l2.store as { client: { listenerCount(event: string): number } };
    expect(client.listenerCount('error')).toBe(1);
    await cache.disconnect();
  });
});

import type KeyvRedis from '@keyv/redis';
import { cacheConfig, redisConfig } from '@platform/config';
import { createCache } from 'cache-manager';
import type { Keyv } from 'keyv';
import { describe, expect, it, vi } from 'vitest';
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
    if (l2 === undefined) throw new Error('L2 store missing');
    const adapter = l2.store as KeyvRedis<unknown>;
    const attempts = { get: vi.spyOn(adapter, 'get'), set: vi.spyOn(adapter, 'set') };
    // The only way an L2 call waits REDIS_CONNECT_TIMEOUT_MS (10 s) is KeyvRedis#getClient racing
    // a connect against that timer. Counting the races instead of timing the loop makes a single
    // stalled call fail the test, with no stopwatch; the race is made to lose at once so a
    // regression fails on the count below, not on the test timeout.
    const races = vi
      .spyOn(
        adapter as unknown as { createTimeoutPromise(ms: number): Promise<never> },
        'createTimeoutPromise',
      )
      .mockRejectedValue(new Error('connectionTimeout race'));
    const cache = createCache({ stores: options.stores as Keyv[], ttl: 1_000 });
    openRedisStores(cache);

    for (let i = 0; i < 20; i += 1) {
      await expect(cache.wrap(`k${String(i)}`, async () => i)).resolves.toBe(i);
    }
    // Every call tried L2 (a read, then the write-back of the loaded value) and none of them
    // raced the connect timeout.
    expect(attempts.get).toHaveBeenCalledTimes(20);
    expect(attempts.set).toHaveBeenCalledTimes(20);
    expect(races).not.toHaveBeenCalled();
    // L1 still works in front of the dead L2.
    await expect(cache.get('k3')).resolves.toBe(3);
    // No per-call listener re-registration on the node-redis client during the outage.
    const { client } = l2.store as { client: { listenerCount(event: string): number } };
    expect(client.listenerCount('error')).toBe(1);
    await cache.disconnect();
  });
});

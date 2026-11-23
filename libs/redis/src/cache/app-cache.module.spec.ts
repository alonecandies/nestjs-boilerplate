import { cacheConfig, redisConfig } from '@platform/config';
import type { Keyv } from 'keyv';
import { describe, expect, it } from 'vitest';
import { AppCacheModule, createCacheOptions } from './app-cache.module.js';
import { BoundedTtlKeyv } from './bounded-ttl-keyv.js';
import { AppCacheService, CACHE_REQUESTS_TOTAL } from './cache.service.js';

describe('createCacheOptions', () => {
  it('builds [L1 (capped LRU), L2 (Redis, namespaced)] with the L2 default TTL', async () => {
    const options = createCacheOptions(
      cacheConfig.parse({
        CACHE_TTL_MS: '30000',
        CACHE_L1_TTL_MS: '2000',
        CACHE_L1_MAX_ITEMS: '50',
      }),
      redisConfig.parse({ REDIS_URL: 'redis://localhost:6399', REDIS_KEY_PREFIX: 'svc' }),
    );
    expect(options.ttl).toBe(30_000);
    expect(options.nonBlocking).toBeUndefined();
    const [l1, l2] = options.stores as Keyv[];
    expect(l1).toBeInstanceOf(BoundedTtlKeyv);
    expect((l1 as BoundedTtlKeyv).maxTtlMs).toBe(2_000);
    expect(l2?.namespace).toBe('svc:cache');
    expect(l1?.listeners('error')).toHaveLength(1);
    expect(l2?.listeners('error')).toHaveLength(1);
    await Promise.all([l1?.disconnect(), l2?.disconnect()]); // never connected → no-op
  });
});

describe('AppCacheModule', () => {
  it('is global and exports AppCacheService', () => {
    const dynamic = AppCacheModule.forRootAsync({ crossInstanceInvalidation: false });
    expect(dynamic.global).toBe(true);
    expect(dynamic.exports).toEqual([AppCacheService]);
  });

  it('registers the cache_requests_total counter AppCacheService injects', () => {
    const dynamic = AppCacheModule.forRootAsync();
    const tokens = (dynamic.providers ?? []).map((p) => (typeof p === 'function' ? p : p.provide));
    expect(tokens).toContain(`PROM_METRIC_${CACHE_REQUESTS_TOTAL.toUpperCase()}`);
  });
});

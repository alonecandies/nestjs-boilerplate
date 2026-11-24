import { Logger } from '@nestjs/common';
import { redisConfig } from '@platform/config';
import { type Cache, createCache } from 'cache-manager';
import { Keyv } from 'keyv';
import { Counter, Registry } from 'prom-client';
import { describe, expect, it, vi } from 'vitest';
import { RedisKeyService } from '../keys/redis-key.service.js';
import { InMemoryRedis } from '../testing/in-memory-redis.js';
import { createL1Store } from './bounded-ttl-keyv.js';
import {
  AppCacheService,
  CACHE_REQUESTS_TOTAL,
  cacheMetricName,
  parseInvalidationMessage,
} from './cache.service.js';

const keys = new RedisKeyService(redisConfig.parse({ REDIS_KEY_PREFIX: 'svc' }));
const flush = async (): Promise<void> => {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
};

/** One "replica": its own L1, shared L2 + Redis bus. */
function replica(l2: Keyv, bus: InMemoryRedis, crossInstanceInvalidation = true) {
  const l1 = createL1Store({ ttlMs: 60_000, maxItems: 100 });
  const cache: Cache = createCache({ stores: [l1, l2], ttl: 30_000 });
  const redis = bus.duplicate();
  const subscriber = bus.duplicate();
  const registry = new Registry();
  const requests = new Counter({
    name: CACHE_REQUESTS_TOTAL,
    help: 'test',
    labelNames: ['cache', 'outcome'],
    registers: [registry],
  });
  const service = new AppCacheService(
    cache,
    redis.asRedis(),
    subscriber.asRedis(),
    keys,
    { crossInstanceInvalidation },
    requests,
  );
  service.onModuleInit();
  /** The value of one `cache_requests_total` series (0 when absent). */
  const count = async (cacheName: string, outcome: 'hit' | 'miss'): Promise<number> => {
    const { values } = await requests.get();
    return (
      values.find((v) => v.labels.cache === cacheName && v.labels.outcome === outcome)?.value ?? 0
    );
  };
  const series = async (): Promise<string[]> =>
    (await requests.get()).values.map((v) => [v.labels.cache, v.labels.outcome].join('/'));
  return { service, l1, redis, subscriber, count, series };
}

async function cluster() {
  const bus = new InMemoryRedis();
  const l2 = new Keyv();
  const a = replica(l2, bus);
  const b = replica(l2, bus);
  await flush(); // subscriptions are fire-and-forget
  return { a, b, l2 };
}

describe('cacheMetricName', () => {
  it('uses the passed name, else the key prefix before the first colon, else other', () => {
    expect(cacheMetricName('user:123', 'users')).toBe('users');
    expect(cacheMetricName('user:123')).toBe('user');
    expect(cacheMetricName('files:7b1c:meta')).toBe('files');
  });

  it('never labels with a raw key', () => {
    expect(cacheMetricName('0b2f6c1e-5c53-4e9c-9d3a-6a7e2f1f8f10')).toBe('other');
    expect(cacheMetricName('a'.repeat(40))).toBe('other');
    expect(cacheMetricName('User:1')).toBe('other');
    expect(cacheMetricName(':abc')).toBe('other');
    expect(cacheMetricName('9lives:1')).toBe('other');
    // an unsafe passed name is ignored: the label falls back to the key's own safe prefix, else other
    expect(cacheMetricName('user:1', 'raw key/with spaces')).toBe('user');
    expect(cacheMetricName('0b2f6c1e-5c53-4e9c-9d3a-6a7e2f1f8f10', 'Raw Key')).toBe('other');
    expect(cacheMetricName('user:1', '')).toBe('user');
  });
});

describe('AppCacheService', () => {
  it('counts one miss, then one hit, under the passed cache name', async () => {
    const { a } = await cluster();
    const loader = vi.fn(async () => ({ id: 'u1' }));
    await a.service.getOrSet('user:u1', loader, 30_000, 'users');
    expect(await a.count('users', 'miss')).toBe(1);
    expect(await a.count('users', 'hit')).toBe(0);
    await a.service.getOrSet('user:u1', loader, 30_000, 'users');
    expect(await a.count('users', 'miss')).toBe(1);
    expect(await a.count('users', 'hit')).toBe(1);
    expect(await a.series()).toEqual(['users/miss', 'users/hit']);
  });

  it('counts a call that coalesced onto another call loader as a hit', async () => {
    const { a } = await cluster();
    const loader = vi.fn(async () => 'v');
    await Promise.all([
      a.service.getOrSet('user:u1', loader),
      a.service.getOrSet('user:u1', loader),
    ]);
    expect(await a.count('user', 'miss')).toBe(1);
    expect(await a.count('user', 'hit')).toBe(1);
  });

  it('counts a raw uuid key under other, never under the key', async () => {
    const { a } = await cluster();
    const key = '0b2f6c1e-5c53-4e9c-9d3a-6a7e2f1f8f10';
    await a.service.getOrSet(key, async () => 1);
    await a.service.getOrSet(key, async () => 1);
    expect(await a.series()).toEqual(['other/miss', 'other/hit']);
  });

  it('counts the 33rd distinct cache name under other and warns once', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const { a } = await cluster();
      const names = Array.from({ length: 33 }, (_, i) => `tenant-${i + 1}`);
      for (const name of names) await a.service.getOrSet(`${name}:k`, async () => 1, 30_000, name);
      for (const name of names.slice(0, 32)) expect(await a.count(name, 'miss')).toBe(1);
      expect(await a.count('tenant-33', 'miss')).toBe(0);
      expect(await a.count('other', 'miss')).toBe(1);
      // a name past the cap stays under other, a name already seen keeps its own label
      await a.service.getOrSet('tenant-34:k', async () => 1, 30_000, 'tenant-34');
      await a.service.getOrSet('tenant-1:k', async () => 1, 30_000, 'tenant-1');
      await a.service.getOrSet('tenant-33:k', async () => 1, 30_000, 'tenant-33');
      expect(await a.count('other', 'miss')).toBe(2);
      expect(await a.count('other', 'hit')).toBe(1);
      expect(await a.count('tenant-1', 'hit')).toBe(1);
      // 32 named miss series, tenant-1/hit, other/miss, other/hit
      expect(await a.series()).toHaveLength(35);
      const capWarnings = warn.mock.calls.filter(([message]) =>
        String(message).includes('distinct cache names'),
      );
      expect(capWarnings).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('counts a miss when the loader fails and rethrows', async () => {
    const { a } = await cluster();
    await expect(
      a.service.getOrSet('user:u1', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await a.count('user', 'miss')).toBe(1);
    expect(await a.count('user', 'hit')).toBe(0);
  });

  it('getOrSet reads through and coalesces concurrent misses', async () => {
    const { a } = await cluster();
    const loader = vi.fn(async () => ({ id: 'u1' }));
    const [first, second] = await Promise.all([
      a.service.getOrSet('user:u1', loader),
      a.service.getOrSet('user:u1', loader),
    ]);
    expect(first).toEqual({ id: 'u1' });
    expect(second).toEqual({ id: 'u1' });
    expect(loader).toHaveBeenCalledOnce();
    await expect(a.service.getOrSet('user:u1', loader)).resolves.toEqual({ id: 'u1' });
    expect(loader).toHaveBeenCalledOnce();
  });

  it('shares values through L2 across replicas', async () => {
    const { a, b } = await cluster();
    await a.service.getOrSet('user:u1', async () => 'v1');
    const loader = vi.fn(async () => 'never');
    await expect(b.service.getOrSet('user:u1', loader)).resolves.toBe('v1');
    expect(loader).not.toHaveBeenCalled();
    await expect(b.l1.get('user:u1')).resolves.toBe('v1'); // back-filled
  });

  it('del() evicts both tiers locally and the L1 copy of every other replica', async () => {
    const { a, b, l2 } = await cluster();
    await a.service.set('user:u1', 'v1');
    await b.service.getOrSet('user:u1', async () => 'unused'); // read-through → B holds an L1 copy
    await expect(b.l1.get('user:u1')).resolves.toBe('v1');

    await a.service.del('user:u1', 'user:u1', '');
    await flush();
    await expect(a.l1.get('user:u1')).resolves.toBeUndefined();
    await expect(l2.get('user:u1')).resolves.toBeUndefined();
    await expect(b.l1.get('user:u1')).resolves.toBeUndefined();
    expect(a.redis.calls.filter((c) => c === 'publish')).toHaveLength(2); // set + del
  });

  it('set() makes other replicas drop their stale L1 copy', async () => {
    const { a, b } = await cluster();
    await a.service.set('k', 'old');
    const loader = vi.fn(async () => 'from-source');
    await expect(b.service.getOrSet('k', loader)).resolves.toBe('old');
    await expect(b.l1.get('k')).resolves.toBe('old');
    await a.service.set('k', 'new');
    await flush();
    await expect(b.l1.get('k')).resolves.toBeUndefined();
    await expect(b.service.getOrSet('k', loader)).resolves.toBe('new');
    expect(loader).not.toHaveBeenCalled();
  });

  it('ignores its own broadcasts and skips empty deletions', async () => {
    const { a } = await cluster();
    const deleteMany = vi.spyOn(a.l1, 'deleteMany');
    await a.service.set('k', 'v');
    await flush();
    expect(deleteMany).not.toHaveBeenCalled();
    await a.service.del();
    expect(a.redis.calls.filter((c) => c === 'publish')).toHaveLength(1);
  });

  it('keeps working when the broadcast fails (L2 already updated)', async () => {
    const { a, l2 } = await cluster();
    vi.spyOn(a.redis, 'publish').mockRejectedValue(new Error('down'));
    await expect(a.service.set('k', 'v')).resolves.toBeUndefined();
    await expect(l2.get('k')).resolves.toBe('v');
  });

  it('does not subscribe or publish when cross-instance invalidation is off', async () => {
    const bus = new InMemoryRedis();
    const r = replica(new Keyv(), bus, false);
    await r.service.set('k', 'v');
    await r.service.del('k');
    expect(r.redis.calls).not.toContain('publish');
    expect(r.subscriber.calls).not.toContain('subscribe');
  });

  it('logs a failed SUBSCRIBE and keeps its listener', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const bus = new InMemoryRedis();
    const subscribe = vi
      .spyOn(InMemoryRedis.prototype, 'subscribe')
      .mockRejectedValueOnce(new Error('Connection is closed.'));
    try {
      const r = replica(new Keyv(), bus);
      await flush();

      expect(subscribe).toHaveBeenCalledExactlyOnceWith('svc:cache:invalidate');
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        'cannot subscribe to svc:cache:invalidate: Connection is closed.',
      );
      expect(r.subscriber.listenerCount('message')).toBe(1);
    } finally {
      subscribe.mockRestore();
      warn.mockRestore();
    }
  });

  it('unsubscribes its listener on module destroy', async () => {
    const { a } = await cluster();
    expect(a.subscriber.listenerCount('message')).toBe(1);
    a.service.onModuleDestroy();
    expect(a.subscriber.listenerCount('message')).toBe(0);
  });
});

describe('parseInvalidationMessage', () => {
  it('returns the keys of well-formed messages from other instances only', () => {
    expect(parseInvalidationMessage(JSON.stringify({ src: 'b', keys: ['x', 'y'] }), 'a')).toEqual([
      'x',
      'y',
    ]);
    expect(parseInvalidationMessage(JSON.stringify({ src: 'a', keys: ['x'] }), 'a')).toEqual([]);
    expect(
      parseInvalidationMessage(JSON.stringify({ src: 'b', keys: ['x', 1, '', null] }), 'a'),
    ).toEqual(['x']);
    expect(parseInvalidationMessage('not json', 'a')).toEqual([]);
    expect(parseInvalidationMessage('null', 'a')).toEqual([]);
    expect(parseInvalidationMessage(JSON.stringify({ src: 'b', keys: 'x' }), 'a')).toEqual([]);
  });
});

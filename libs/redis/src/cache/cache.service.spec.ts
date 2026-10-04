import { redisConfig } from '@app/config';
import { type Cache, createCache } from 'cache-manager';
import { Keyv } from 'keyv';
import { describe, expect, it, vi } from 'vitest';
import { RedisKeyService } from '../keys/redis-key.service.js';
import { InMemoryRedis } from '../testing/in-memory-redis.js';
import { createL1Store } from './bounded-ttl-keyv.js';
import { AppCacheService, parseInvalidationMessage } from './cache.service.js';

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
  const service = new AppCacheService(cache, redis.asRedis(), subscriber.asRedis(), keys, {
    crossInstanceInvalidation,
  });
  service.onModuleInit();
  return { service, l1, redis, subscriber };
}

async function cluster() {
  const bus = new InMemoryRedis();
  const l2 = new Keyv();
  const a = replica(l2, bus);
  const b = replica(l2, bus);
  await flush(); // subscriptions are fire-and-forget
  return { a, b, l2 };
}

describe('AppCacheService', () => {
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

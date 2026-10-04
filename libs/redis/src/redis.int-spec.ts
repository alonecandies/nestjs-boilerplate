/**
 * Integration tests against a REAL Redis (docker compose `redis`, or REDIS_URL). Only run with
 * `INTEGRATION=1 bunx vitest run --project redis:int`. Every key lives under a random prefix and
 * is removed afterwards.
 */
import { createServer } from 'node:http';
import { generateId } from '@app/common';
import { cacheConfig, redisConfig } from '@app/config';
import type { INestApplicationContext } from '@nestjs/common';
import { Redlock } from '@sesamecare-oss/redlock';
import { type Cache, createCache } from 'cache-manager';
import type { Redis } from 'ioredis';
import type { Keyv } from 'keyv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCacheOptions } from './cache/app-cache.module.js';
import { AppCacheService } from './cache/cache.service.js';
import { RedisKeyService } from './keys/redis-key.service.js';
import { DistributedLockService, REDLOCK_SETTINGS } from './lock/distributed-lock.service.js';
import { closeRedisClient, createRedisClient, waitForRedisReady } from './redis.factory.js';
import { RedisIoAdapter } from './socket-io/redis-io.adapter.js';
import { InMemoryRedis } from './testing/in-memory-redis.js';
import { RedisThrottlerStorage } from './throttler/redis-throttler.storage.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const prefix = `it-${generateId()}`;
const config = { ...redisConfig.parse(), keyPrefix: prefix };
const keys = new RedisKeyService(config);
let redis: Redis;

beforeAll(async () => {
  redis = createRedisClient(config);
  await waitForRedisReady(redis, 5_000);
});

afterAll(async () => {
  const stream = redis.scanStream({ match: `${prefix}:*`, count: 500 }) as AsyncIterable<string[]>;
  for await (const batch of stream) if (batch.length > 0) await redis.unlink(...batch);
  await closeRedisClient(redis);
});

describe('throttle Lua script (real Redis) == JS model', () => {
  it('counts, blocks, resets — identically to the in-memory model', async () => {
    const real = new RedisThrottlerStorage(redis, keys);
    let now = 0;
    const model = new RedisThrottlerStorage(new InMemoryRedis({ now: () => now }).asRedis(), keys);
    const step = async (advanceMs: number) => {
      if (advanceMs) await sleep(advanceMs);
      now += advanceMs;
      const [a, b] = await Promise.all([
        real.increment('t', 300, 2, 600, 'default'),
        model.increment('t', 300, 2, 600, 'default'),
      ]);
      return { real: a, model: b };
    };
    for (const advance of [0, 0, 0, 100, 650]) {
      const { real: r, model: m } = await step(advance);
      expect({ hits: r.totalHits, blocked: r.isBlocked }).toEqual({
        hits: m.totalHits,
        blocked: m.isBlocked,
      });
    }
    // Final state: a fresh window after the block expired.
    const base = keys.key('throttle', '{default:t}');
    expect(await redis.get(`${base}:hits`)).toBe('1');
    expect(await redis.exists(`${base}:block`)).toBe(0);
  });
});

describe('DistributedLockService (real redlock)', () => {
  it('lets exactly one concurrent caller run, auto-extends long runs, then releases', async () => {
    const locks = new DistributedLockService(new Redlock([redis], REDLOCK_SETTINGS), keys);
    let running = 0;
    let maxConcurrent = 0;
    const job = async (): Promise<string> => {
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      await sleep(900); // longer than the 400 ms TTL → must be extended
      running--;
      return 'done';
    };
    const first = locks.using('job', 400, job);
    await sleep(50);
    const [second, third] = await Promise.all([
      locks.using('job', 400, job),
      sleep(600).then(() => locks.using('job', 400, job)), // after the original TTL
    ]);
    await expect(first).resolves.toEqual({ acquired: true, result: 'done' });
    expect(second).toEqual({ acquired: false, reason: 'held' });
    expect(third).toEqual({ acquired: false, reason: 'held' });
    expect(maxConcurrent).toBe(1);
    expect(await redis.exists(keys.key('lock', 'job'))).toBe(0);
  });
});

describe('two-tier cache (real Redis L2 + pub/sub invalidation)', () => {
  const replicas: { service: AppCacheService; cache: Cache; subscriber: Redis }[] = [];

  beforeAll(async () => {
    const cacheCfg = cacheConfig.parse({ CACHE_TTL_MS: '30000', CACHE_L1_TTL_MS: '10000' });
    for (let i = 0; i < 2; i++) {
      const options = createCacheOptions(cacheCfg, config);
      const cache = createCache({ ...options, stores: options.stores as Keyv[] });
      const subscriber = redis.duplicate({ lazyConnect: true, maxRetriesPerRequest: null });
      subscriber.on('error', () => undefined);
      const service = new AppCacheService(cache, redis, subscriber, keys, {
        crossInstanceInvalidation: true,
      });
      service.onModuleInit();
      replicas.push({ service, cache, subscriber });
    }
    await sleep(200); // subscriptions established
  });

  afterAll(async () => {
    for (const { cache, subscriber } of replicas) {
      await cache.disconnect();
      await closeRedisClient(subscriber);
    }
  });

  it('shares values via L2 under <prefix>:cache: and invalidates other L1 copies', async () => {
    const [a, b] = replicas as [(typeof replicas)[0], (typeof replicas)[0]];
    await a.service.set('user:1', { v: 1 });
    expect(await redis.get(`${prefix}:cache:user:1`)).toContain('"v":1');
    await expect(b.service.getOrSet('user:1', async () => ({ v: -1 }))).resolves.toEqual({ v: 1 });

    await a.service.set('user:1', { v: 2 });
    await sleep(100); // pub/sub delivery
    await expect(b.service.getOrSet('user:1', async () => ({ v: -1 }))).resolves.toEqual({ v: 2 });

    await b.service.del('user:1');
    await sleep(100);
    await expect(a.service.get('user:1')).resolves.toBeUndefined();
  });
});

describe('RedisIoAdapter (real Redis)', () => {
  it('connects pub/sub, attaches the adapter and QUITs on dispose', async () => {
    const adapter = new RedisIoAdapter(
      createServer() as unknown as INestApplicationContext,
      config,
    );
    await adapter.connectToRedis();
    const clients = [...(Reflect.get(adapter, 'clients') as Redis[])]; // dispose() empties the array
    expect(clients.map((client) => client.status)).toEqual(['ready', 'ready']);
    const server = adapter.createIOServer(0);
    expect(server.of('/').adapter.constructor.name).toBe('RedisAdapter');
    await adapter.close(server);
    await adapter.dispose();
    expect(clients.map((client) => client.status)).toEqual(['end', 'end']);
  });
});

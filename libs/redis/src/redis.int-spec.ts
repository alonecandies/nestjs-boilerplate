/**
 * Integration tests against a REAL Redis (docker compose `redis`, or REDIS_URL). Only run with
 * `INTEGRATION=1 bunx vitest run --project redis:int`. Every key lives under a random prefix and
 * is removed afterwards.
 */
import { createServer } from 'node:http';
import type { INestApplicationContext } from '@nestjs/common';
import { generateId } from '@platform/common';
import { cacheConfig, redisConfig, throttleConfig } from '@platform/config';
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
import { ConnectionCaps } from './throttler/connection-caps.js';
import { RateLimitCharger } from './throttler/rate-limit-charger.js';
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

describe('throttle Lua script, weighted hits (real Redis)', () => {
  it('INCRBY adds the weight and blocks once the weighted total passes the limit', async () => {
    const storage = new RedisThrottlerStorage(redis, keys);
    const hit = (weight: number) =>
      storage.incrementBy('w', 60_000, 100, 60_000, 'graphql', weight);
    await expect(hit(60)).resolves.toMatchObject({ totalHits: 60, isBlocked: false });
    await expect(hit(40)).resolves.toMatchObject({ totalHits: 100, isBlocked: false });
    await expect(hit(1)).resolves.toMatchObject({
      totalHits: 101,
      isBlocked: true,
      timeToBlockExpire: 60,
    });
    const base = keys.key('throttle', '{graphql:w}');
    expect(await redis.exists(`${base}:hits`)).toBe(0);
    expect(await redis.exists(`${base}:block`)).toBe(1);
  });
});

describe('connection-slot Lua script (real Redis) == JS model', () => {
  const nowSec = (): number => Math.floor(Date.now() / 1000);
  /** A token that expired two minutes ago: the slot ttl wins its deadline. */
  const expiredToken = (): number => nowSec() - 120;
  /** The slot ttl the expiry steps use (the `THROTTLE_WS_SOCKET_TTL_MS` minimum). */
  const SHORT_TTL_MS = 1_000;

  /**
   * One user's sockets on real Redis and on the JS model, cap 2. Every step runs on both and must
   * give the same answer; the slot ids differ (one per acquire), so each side keeps its own.
   */
  function slotPair(ttlMs = 3_600_000) {
    const env = { THROTTLE_WS_SOCKETS_PER_USER: '2', THROTTLE_WS_SOCKET_TTL_MS: String(ttlMs) };
    const model = new InMemoryRedis();
    const make = (client: Redis) =>
      new ConnectionCaps(
        client,
        keys,
        throttleConfig.parse(env),
        new RateLimitCharger(new RedisThrottlerStorage(client, keys)),
      );
    const real = make(redis);
    const fake = make(model.asRedis());
    const user = generateId();
    const key = keys.key('wsslot', `{${user}}`);
    const ids = new Map<string, [real: string, model: string]>();
    const idsOf = (name: string): [string, string] => {
      const pair = ids.get(name);
      if (pair === undefined) throw new Error(`${name} is not open`);
      return pair;
    };
    return {
      key,
      async open(name: string, tokenExpSec = nowSec() + 900): Promise<boolean> {
        const [r, m] = await Promise.all([
          real.acquireSocket(user, tokenExpSec),
          fake.acquireSocket(user, tokenExpSec),
        ]);
        expect(r.admitted).toBe(m.admitted);
        if (r.admitted && m.admitted) ids.set(name, [r.id, m.id]);
        return r.admitted;
      },
      /** Sends `name`'s acquire again with the same slot id (an ioredis resend). */
      async resend(name: string, tokenExpSec = nowSec() + 900): Promise<number> {
        const [r, m] = idsOf(name);
        const args = [2, ttlMs, tokenExpSec * 1000 + 60_000] as const;
        const [a, b] = await Promise.all([
          redis.appConnSlot(key, r, ...args),
          model.asRedis().appConnSlot(key, m, ...args),
        ]);
        expect(a).toBe(b);
        return a;
      },
      /** An admitted socket whose acquire never reached Redis (rejected before it was sent). */
      failOpen(name: string): void {
        ids.set(name, [generateId(), generateId()]);
      },
      /** Releases `name`'s slot `times` times (2 = a resent release). */
      async close(name: string, times = 1): Promise<void> {
        const [r, m] = idsOf(name);
        for (let i = 0; i < times; i++) {
          await Promise.all([real.releaseSocket(user, r), fake.releaseSocket(user, m)]);
        }
        ids.delete(name);
      },
      /** Members of the user's slot set, expired ones not yet pruned included. */
      async held(): Promise<number> {
        const [r, m] = [await redis.zcard(key), model.zcardSync(key)];
        expect(r).toBe(m);
        return r;
      },
      /** The real key expires exactly with its latest slot. */
      async expectKeyExpiryAtLatestSlot(): Promise<void> {
        const [, latest] = await redis.zrange(key, -1, '-1', 'WITHSCORES');
        expect(await redis.call('PEXPIRETIME', key)).toBe(Number(latest));
        // The model reads the wall clock, so allow the few ms between its two reads.
        const [modelLatest] = model.zrangeWithScoresSync(key, -1, -1);
        expect(modelLatest).toBeDefined();
        const modelExpiry = Date.now() + model.pttlSync(key);
        expect(Math.abs(modelExpiry - (modelLatest?.[1] ?? 0))).toBeLessThanOrEqual(5);
      },
    };
  }

  it('a resent release never over-admits', async () => {
    const slots = slotPair();
    expect(await slots.open('A')).toBe(true);
    expect(await slots.open('B')).toBe(true);
    await slots.close('A', 2);
    const admitted = [await slots.open('C'), await slots.open('D')];
    expect(admitted.filter(Boolean)).toHaveLength(1);
    expect(await slots.held()).toBe(2);
    await slots.expectKeyExpiryAtLatestSlot();
  });

  it('a resent acquire at the cap is admitted again and counted once', async () => {
    const slots = slotPair();
    expect(await slots.open('A')).toBe(true);
    expect(await slots.open('B')).toBe(true);
    expect(await slots.resend('B')).toBe(1);
    expect(await slots.held()).toBe(2);
    expect(await slots.open('C')).toBe(false);
  });

  it('a lost reply is released by its id; a release never sent leaks only until the deadline', async () => {
    const slots = slotPair(SHORT_TTL_MS);
    // E's acquire ran (its reply lost): the caller still releases it by id.
    expect(await slots.open('E', expiredToken())).toBe(true);
    await slots.close('E');
    expect(await slots.held()).toBe(0);
    // F's release never reaches Redis: its slot stays until its deadline.
    expect(await slots.open('F', expiredToken())).toBe(true);
    expect(await slots.held()).toBe(1);
    await sleep(SHORT_TTL_MS + 200);
    // The key itself went with F's deadline, its last.
    expect(await redis.exists(slots.key)).toBe(0);
    // 15-minute tokens: X and Y cannot expire mid-step however slow the host is.
    expect(await slots.open('X')).toBe(true);
    expect(await slots.open('Y')).toBe(true);
    expect(await slots.open('Z')).toBe(false);
    expect(await slots.held()).toBe(2);
  });

  it('an acquire that never ran is released without freeing another slot', async () => {
    const slots = slotPair();
    expect(await slots.open('I')).toBe(true);
    slots.failOpen('H');
    await slots.close('H');
    expect(await slots.held()).toBe(1);
    expect(await slots.open('J')).toBe(true);
    expect(await slots.open('K')).toBe(false);
  });

  it("the key's expiry never shortens: a later, shorter slot does not drop an earlier one", async () => {
    const slots = slotPair(SHORT_TTL_MS);
    // A's token outlives the ttl: its deadline is its expiry + 60 s, about 10 s from now.
    expect(await slots.open('A', nowSec() - 60 + 10)).toBe(true);
    expect(await slots.open('B', expiredToken())).toBe(true);
    await slots.expectKeyExpiryAtLatestSlot();
    await slots.close('B');
    // Past B's deadline, not A's.
    await sleep(SHORT_TTL_MS + 200);
    expect(await slots.held()).toBe(1);
    // 15-minute tokens: C cannot expire before D asks, however slow the host is.
    expect(await slots.open('C')).toBe(true);
    expect(await slots.open('D')).toBe(false);
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

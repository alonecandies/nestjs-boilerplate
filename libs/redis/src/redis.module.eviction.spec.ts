import { type FactoryProvider, Logger, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { RedisConfig } from '@platform/config';
import type { Redis } from 'ioredis';
import { register } from 'prom-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REDIS_CLIENT } from './redis.constants.js';
import type * as RedisFactory from './redis.factory.js';
import { RedisModule } from './redis.module.js';
import { REDIS_EVICTION_POLICY_SAFE } from './redis-eviction-check.js';
import { InMemoryRedis } from './testing/in-memory-redis.js';

const factory = vi.hoisted(() => ({ policy: 'noeviction', stallInfo: false }));

// The factory hands out a ready InMemoryRedis, so the module boots through its waitForReady path.
// With `stallInfo` its INFO never answers: a connection that dropped right after `ready`.
vi.mock('./redis.factory.js', async (importOriginal) => ({
  ...(await importOriginal<typeof RedisFactory>()),
  createRedisClient: () => {
    const redis = new InMemoryRedis({ maxmemoryPolicy: factory.policy, connectionName: 'spec' });
    if (factory.stallInfo) {
      vi.spyOn(redis, 'info').mockReturnValue(new Promise<string>(() => undefined));
    }
    return redis.asRedis();
  },
  waitForRedisReady: async () => undefined,
}));

/** The `REDIS_CLIENT` provider's factory, called directly so the test controls the clock. */
function mainClientFactory(): (
  config: RedisConfig,
  options: object,
  app: undefined,
) => Promise<Redis> {
  const provider = RedisModule.forRootAsync().providers?.find(
    (candidate): candidate is FactoryProvider =>
      typeof candidate === 'object' && 'provide' in candidate && candidate.provide === REDIS_CLIENT,
  );
  if (provider === undefined) throw new Error('REDIS_CLIENT provider not found');
  return provider.useFactory as never;
}

describe('RedisModule boot check of the eviction policy', () => {
  let error: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    register.removeSingleMetric(REDIS_EVICTION_POLICY_SAFE);
    error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    error.mockRestore();
    vi.useRealTimers();
    factory.stallInfo = false;
    register.removeSingleMetric(REDIS_EVICTION_POLICY_SAFE);
  });

  async function boot(policy: string): Promise<void> {
    factory.policy = policy;
    @Module({
      imports: [ConfigModule.forRoot({ ignoreEnvFile: true }), RedisModule.forRootAsync()],
    })
    class TestModule {}
    const app = await NestFactory.createApplicationContext(TestModule, { logger: false });
    await app.close();
  }

  it('logs the error and boots when the policy evicts keys', async () => {
    await boot('allkeys-lru');
    expect(error).toHaveBeenCalledTimes(1);
    const metric = register.getSingleMetric(REDIS_EVICTION_POLICY_SAFE);
    expect(((await metric?.get())?.values ?? []).map((sample) => sample.value)).toEqual([0]);
  });

  it('stays quiet for noeviction', async () => {
    await boot('noeviction');
    expect(error).not.toHaveBeenCalled();
    const metric = register.getSingleMetric(REDIS_EVICTION_POLICY_SAFE);
    expect(((await metric?.get())?.values ?? []).map((sample) => sample.value)).toEqual([1]);
  });

  it('gives up on an INFO that never answers after 2 s and boots without the gauge', async () => {
    vi.useFakeTimers();
    factory.stallInfo = true;
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const config = {
      url: 'redis://127.0.0.1:6379',
      keyPrefix: 'spec',
      connectTimeoutMs: 1_000,
    } as RedisConfig;
    let client: Redis | undefined;
    const pending = mainClientFactory()(config, {}, undefined).then((created) => {
      client = created;
      return created;
    });

    await vi.advanceTimersByTimeAsync(1_999);
    expect(client).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(client).toBeDefined();
    await pending;

    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    expect(register.getSingleMetric(REDIS_EVICTION_POLICY_SAFE)).toBeUndefined();
    warn.mockRestore();
  });
});

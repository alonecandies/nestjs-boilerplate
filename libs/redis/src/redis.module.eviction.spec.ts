import { Logger, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { register } from 'prom-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as RedisFactory from './redis.factory.js';
import { RedisModule } from './redis.module.js';
import { REDIS_EVICTION_POLICY_SAFE } from './redis-eviction-check.js';
import { InMemoryRedis } from './testing/in-memory-redis.js';

const factory = vi.hoisted(() => ({ policy: 'noeviction' }));

// The factory hands out a ready InMemoryRedis, so the module boots through its waitForReady path.
vi.mock('./redis.factory.js', async (importOriginal) => ({
  ...(await importOriginal<typeof RedisFactory>()),
  createRedisClient: () =>
    new InMemoryRedis({ maxmemoryPolicy: factory.policy, connectionName: 'spec' }).asRedis(),
  waitForRedisReady: async () => undefined,
}));

describe('RedisModule boot check of the eviction policy', () => {
  let error: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    register.removeSingleMetric(REDIS_EVICTION_POLICY_SAFE);
    error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    error.mockRestore();
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
});

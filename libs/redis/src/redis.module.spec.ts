import type { INestApplicationContext } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { Redis } from 'ioredis';
import { afterEach, describe, expect, it } from 'vitest';
import { RedisHealthIndicator } from './health/redis.health.js';
import { RedisKeyService } from './keys/redis-key.service.js';
import { DistributedLockService } from './lock/distributed-lock.service.js';
import { getLockRunner } from './lock/lock-registry.js';
import { REDIS_CLIENT, REDIS_SUBSCRIBER, REDLOCK } from './redis.constants.js';
import { RedisModule } from './redis.module.js';

describe('RedisModule (DI wiring, no connection)', () => {
  let app: INestApplicationContext | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function boot(): Promise<INestApplicationContext> {
    @Module({
      imports: [
        ConfigModule.forRoot({ ignoreEnvFile: true }),
        // lazyConnect + waitForReady:false → the container boots without a Redis server.
        RedisModule.forRootAsync({
          connectionName: 'spec',
          clientOptions: { lazyConnect: true },
          waitForReady: false,
        }),
      ],
    })
    class TestModule {}
    app = await NestFactory.createApplicationContext(TestModule, { logger: false });
    return app;
  }

  it('provides the clients, key builder, locks and health indicator globally', async () => {
    const ctx = await boot();
    const client = ctx.get<Redis>(REDIS_CLIENT);
    const subscriber = ctx.get<Redis>(REDIS_SUBSCRIBER);
    expect(client.status).toBe('wait');
    expect(client.options.connectionName).toBe('spec');
    expect(client.options.enableAutoPipelining).toBe(true);
    expect(subscriber).not.toBe(client);
    expect(subscriber.options).toMatchObject({
      connectionName: 'spec:sub',
      lazyConnect: true,
      maxRetriesPerRequest: null,
      enableAutoPipelining: false,
    });
    expect(subscriber.listenerCount('error')).toBe(1);
    expect(ctx.get(RedisKeyService).key('x')).toMatch(/:x$/);
    expect(ctx.get(REDLOCK)).toBeDefined();
    expect(ctx.get(RedisHealthIndicator).key).toBe('redis');
    // DistributedLockService registered itself for @WithLock during module init.
    expect(getLockRunner()).toBe(ctx.get(DistributedLockService));
  });

  it('closes both connections on shutdown', async () => {
    const ctx = await boot();
    const client = ctx.get<Redis>(REDIS_CLIENT);
    const subscriber = ctx.get<Redis>(REDIS_SUBSCRIBER);
    await ctx.close();
    app = undefined;
    expect(client.status).toBe('end');
    expect(subscriber.status).toBe('end');
  });
});

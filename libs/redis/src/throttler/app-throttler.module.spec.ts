import { redisConfig } from '@app/config';
import { Global, type INestApplicationContext, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { getStorageToken, type ThrottlerStorage } from '@nestjs/throttler';
import { afterEach, describe, expect, it } from 'vitest';
import { RedisKeyService } from '../keys/redis-key.service.js';
import { REDIS_CLIENT } from '../redis.constants.js';
import { InMemoryRedis } from '../testing/in-memory-redis.js';
import { AppThrottlerGuard } from './app-throttler.guard.js';
import { AppThrottlerModule } from './app-throttler.module.js';
import { RedisThrottlerStorage } from './redis-throttler.storage.js';

const redis = new InMemoryRedis();

/** Stands in for the global RedisModule (no connection). */
@Global()
@Module({
  imports: [ConfigModule.forFeature(redisConfig)],
  providers: [{ provide: REDIS_CLIENT, useValue: redis.asRedis() }, RedisKeyService],
  exports: [REDIS_CLIENT, RedisKeyService],
})
class FakeRedisModule {}

describe('AppThrottlerModule (DI wiring)', () => {
  let app: INestApplicationContext | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('wires the Redis storage and the guard from config', async () => {
    @Module({
      imports: [
        ConfigModule.forRoot({ ignoreEnvFile: true }),
        FakeRedisModule,
        AppThrottlerModule.forRootAsync(),
      ],
    })
    class TestModule {}

    app = await NestFactory.createApplicationContext(TestModule, { logger: false });
    const storage = app.get<ThrottlerStorage>(getStorageToken());
    expect(storage).toBeInstanceOf(RedisThrottlerStorage);
    await expect(storage.increment('k', 1_000, 5, 1_000, 'default')).resolves.toMatchObject({
      totalHits: 1,
      isBlocked: false,
    });
    const guard = app.get(AppThrottlerGuard);
    expect(guard).toBeInstanceOf(AppThrottlerGuard);
    // Property-injected throttle namespace (the @AuthThrottle() limits).
    expect(Reflect.get(guard, 'limits')).toMatchObject({ authLimit: 10, authTtlMs: 60_000 });
  });

  it('can leave APP_GUARD registration to the app', () => {
    const dynamic = AppThrottlerModule.forRootAsync({ globalGuard: false });
    expect(dynamic.providers).toEqual([AppThrottlerGuard]);
    expect(AppThrottlerModule.forRootAsync().providers).toHaveLength(2);
  });
});

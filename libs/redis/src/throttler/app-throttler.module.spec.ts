import { Controller, Global, type INestApplicationContext, Module, Post } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { getStorageToken, Throttle, type ThrottlerStorage } from '@nestjs/throttler';
import { redisConfig } from '@platform/config';
import { register } from 'prom-client';
import { afterEach, describe, expect, it } from 'vitest';
import { RedisKeyService } from '../keys/redis-key.service.js';
import { REDIS_CLIENT } from '../redis.constants.js';
import { InMemoryRedis } from '../testing/in-memory-redis.js';
import { AppThrottlerGuard } from './app-throttler.guard.js';
import { AppThrottlerModule } from './app-throttler.module.js';
import { RateLimit } from './rate-limit.decorator.js';
import { RateLimitModule } from './rate-limit.module.js';
import { RateLimitPolicyRegistry } from './rate-limit-policy.js';
import {
  RATE_LIMIT_FAIL_OPEN_TOKEN,
  RATE_LIMIT_FAIL_OPEN_TOTAL,
  RedisThrottlerStorage,
} from './redis-throttler.storage.js';
import { THROTTLER } from './throttle.constants.js';

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
    await expect(storage.increment('k', 1_000, 5, 1_000, 'user')).resolves.toMatchObject({
      totalHits: 1,
      isBlocked: false,
    });
    const guard = app.get(AppThrottlerGuard);
    expect(guard).toBeInstanceOf(AppThrottlerGuard);
  });

  it('can leave APP_GUARD registration to the app', () => {
    const dynamic = AppThrottlerModule.forRootAsync({ globalGuard: false });
    expect(dynamic.providers).not.toContainEqual(expect.objectContaining({ provide: APP_GUARD }));
    expect(AppThrottlerModule.forRootAsync().providers).toContainEqual({
      provide: APP_GUARD,
      useExisting: AppThrottlerGuard,
    });
  });

  it('collects RateLimitModule.forFeature policies into the global registry', async () => {
    @Module({
      imports: [
        RateLimitModule.forFeature({
          useFactory: () => [{ name: 'test.thing', key: 'user', limit: 2, ttlMs: 1_000 }],
        }),
      ],
    })
    class FeatureModule {}
    @Module({
      imports: [
        ConfigModule.forRoot({ ignoreEnvFile: true }),
        FakeRedisModule,
        AppThrottlerModule.forRootAsync(),
        FeatureModule,
      ],
    })
    class TestModule {}

    app = await NestFactory.createApplicationContext(TestModule, { logger: false });
    expect(app.get(RateLimitPolicyRegistry).require('test.thing')).toMatchObject({ limit: 2 });
  });

  it('refuses to boot when @RateLimit names an unregistered policy', async () => {
    @Controller('x')
    class BadController {
      @Post() @RateLimit('test.missing') handle(): void {
        // route handler stub
      }
    }
    @Module({
      imports: [
        ConfigModule.forRoot({ ignoreEnvFile: true }),
        FakeRedisModule,
        AppThrottlerModule.forRootAsync(),
      ],
      controllers: [BadController],
    })
    class TestModule {}

    await expect(
      NestFactory.createApplicationContext(TestModule, { logger: false, abortOnError: false }),
    ).rejects.toThrow('@RateLimit names unregistered policies: test.missing');
  });

  it('refuses to boot when a handler carries an @Throttle override', async () => {
    @Controller('y')
    class OverrideController {
      @Post() @Throttle({ user: { limit: 2, ttl: 1_000 } }) handle(): void {
        // route handler stub
      }
    }
    @Module({
      imports: [
        ConfigModule.forRoot({ ignoreEnvFile: true }),
        FakeRedisModule,
        AppThrottlerModule.forRootAsync(),
      ],
      controllers: [OverrideController],
    })
    class TestModule {}

    await expect(
      NestFactory.createApplicationContext(TestModule, { logger: false, abortOnError: false }),
    ).rejects.toThrow('@Throttle overrides are not supported: OverrideController.handle');
  });

  it('refuses to boot when a controller class carries an @Throttle override', async () => {
    @Throttle({ route: { limit: 1, ttl: 1_000 } })
    @Controller('z')
    class ClassOverrideController {
      @Post() handle(): void {
        // route handler stub
      }
    }
    @Module({
      imports: [
        ConfigModule.forRoot({ ignoreEnvFile: true }),
        FakeRedisModule,
        AppThrottlerModule.forRootAsync(),
      ],
      controllers: [ClassOverrideController],
    })
    class TestModule {}

    await expect(
      NestFactory.createApplicationContext(TestModule, { logger: false, abortOnError: false }),
    ).rejects.toThrow('@Throttle overrides are not supported: ClassOverrideController');
  });

  it('registers the fail-open counter and passes THROTTLE_REDIS_TIMEOUT_MS to the storage', async () => {
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
    expect(Reflect.get(storage, 'commandTimeoutMs')).toBe(250);
    expect(app.get(RATE_LIMIT_FAIL_OPEN_TOKEN)).toHaveProperty('inc');
  });

  it('creates rate_limit_fail_open_total{throttler} at 0 for every throttler at boot', async () => {
    @Module({
      imports: [
        ConfigModule.forRoot({ ignoreEnvFile: true }),
        FakeRedisModule,
        AppThrottlerModule.forRootAsync(),
      ],
    })
    class TestModule {}
    app = await NestFactory.createApplicationContext(TestModule, { logger: false });

    // A series created by its first `inc()` starts at 1 and `increase()` misses that step, so the
    // `RateLimitFailOpen` alert would not see the first fail-open of a throttler.
    const metric = register.getSingleMetric(RATE_LIMIT_FAIL_OPEN_TOTAL);
    const values = (await (metric as { get(): Promise<{ values: { labels: object }[] }> }).get())
      .values;
    expect(values.map((sample) => sample.labels).sort(byThrottler)).toEqual(
      Object.values(THROTTLER)
        .map((throttler) => ({ throttler }))
        .sort(byThrottler),
    );
  });
});

function byThrottler(a: object, b: object): number {
  return JSON.stringify(a).localeCompare(JSON.stringify(b));
}

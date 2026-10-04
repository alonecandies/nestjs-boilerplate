import { type ThrottleConfig, throttleConfig } from '@app/config';
import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, type ThrottlerModuleOptions } from '@nestjs/throttler';
import type { Redis } from 'ioredis';
import { RedisKeyService } from '../keys/redis-key.service.js';
import { REDIS_CLIENT } from '../redis.constants.js';
import { AppThrottlerGuard } from './app-throttler.guard.js';
import { RedisThrottlerStorage } from './redis-throttler.storage.js';
import { DEFAULT_THROTTLE_EXEMPT_PATHS, DEFAULT_THROTTLER_NAME } from './throttle.constants.js';
import { createThrottleSkipIf } from './throttle-exempt.util.js';

export interface AppThrottlerModuleOptions {
  /** Path prefixes never rate limited. Default `DEFAULT_THROTTLE_EXEMPT_PATHS` (ops endpoints). */
  exemptPaths?: readonly string[];
  /** User agents never rate limited (e.g. `[/kube-probe/i]`). Default: none. */
  ignoreUserAgents?: RegExp[];
  /** See `RedisThrottlerStorageOptions.failOpen`. Default `true`. */
  failOpen?: boolean;
  /**
   * Register `AppThrottlerGuard` as `APP_GUARD` (default `true`). Set `false` to register it
   * yourself — e.g. to control its position relative to other global guards.
   */
  globalGuard?: boolean;
}

/**
 * Redis-backed rate limiting for every replica: one `default` throttler
 * (`THROTTLE_LIMIT` per `THROTTLE_TTL_MS`), `@AuthThrottle()` for credential endpoints,
 * `@SkipThrottle()` to opt out, ops paths exempt. Requires `RedisModule` (global).
 *
 * Import `AuthModule` BEFORE this module so `JwtAuthGuard` has set `req.user` when the throttler
 * picks its tracker (global guards run in registration order); otherwise limits are per IP only.
 */
@Module({})
export class AppThrottlerModule {
  static forRootAsync(options: AppThrottlerModuleOptions = {}): DynamicModule {
    const skipIf = createThrottleSkipIf(options.exemptPaths ?? DEFAULT_THROTTLE_EXEMPT_PATHS);
    const guardProviders: Provider[] = [AppThrottlerGuard];
    if (options.globalGuard ?? true) {
      guardProviders.push({ provide: APP_GUARD, useExisting: AppThrottlerGuard });
    }
    return {
      module: AppThrottlerModule,
      imports: [
        // AppThrottlerGuard injects the namespace for the @AuthThrottle() limits.
        ConfigModule.forFeature(throttleConfig),
        // ThrottlerModule is @Global: its options + storage tokens are visible to the guard.
        ThrottlerModule.forRootAsync({
          imports: [ConfigModule.forFeature(throttleConfig)],
          inject: [throttleConfig.KEY, REDIS_CLIENT, RedisKeyService],
          useFactory: (
            config: ThrottleConfig,
            redis: Redis,
            keys: RedisKeyService,
          ): ThrottlerModuleOptions => ({
            throttlers: [{ name: DEFAULT_THROTTLER_NAME, ttl: config.ttlMs, limit: config.limit }],
            storage: new RedisThrottlerStorage(
              redis,
              keys,
              options.failOpen === undefined ? {} : { failOpen: options.failOpen },
            ),
            skipIf,
            ...(options.ignoreUserAgents ? { ignoreUserAgents: options.ignoreUserAgents } : {}),
          }),
        }),
      ],
      providers: guardProviders,
      exports: [AppThrottlerGuard],
    };
  }
}

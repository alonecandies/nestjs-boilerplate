import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR, DiscoveryModule } from '@nestjs/core';
import { ThrottlerModule, type ThrottlerModuleOptions } from '@nestjs/throttler';
import { type ThrottleConfig, throttleConfig } from '@platform/config';
import { makeCounterProvider } from '@platform/observability';
import type { Redis } from 'ioredis';
import { RedisKeyService } from '../keys/redis-key.service.js';
import { REDIS_CLIENT } from '../redis.constants.js';
import { AppThrottlerGuard } from './app-throttler.guard.js';
import { LockoutResetInterceptor } from './lockout-reset.interceptor.js';
import { RateLimitPolicyRegistry } from './rate-limit-policy.js';
import { RateLimitPolicyValidator } from './rate-limit-policy.validator.js';
import {
  RATE_LIMIT_FAIL_OPEN_TOKEN,
  RATE_LIMIT_FAIL_OPEN_TOTAL,
  RedisThrottlerStorage,
} from './redis-throttler.storage.js';
import { DEFAULT_THROTTLE_EXEMPT_PATHS, THROTTLER } from './throttle.constants.js';
import { createThrottleSkipIf } from './throttle-exempt.util.js';
import { WsThrottlerGuard } from './ws-throttler.guard.js';

const failOpenCounter = makeCounterProvider({
  name: RATE_LIMIT_FAIL_OPEN_TOTAL,
  help: 'Requests let through without rate limiting because Redis was unavailable or slow',
  labelNames: ['throttler'],
});

@Module({ providers: [failOpenCounter], exports: [failOpenCounter] })
class RateLimitMetricsModule {}

export interface AppThrottlerModuleOptions {
  /** Path prefixes never rate limited. Default `DEFAULT_THROTTLE_EXEMPT_PATHS` (ops endpoints). */
  exemptPaths?: readonly string[];
  /** User agents never rate limited (e.g. `[/kube-probe/i]`). Default: none. */
  ignoreUserAgents?: RegExp[];
  /** See RedisThrottlerStorageOptions.failOpen. Default: budgets open, auth/lockout closed. */
  failOpen?: boolean | ((throttlerName: string) => boolean);
  /**
   * Register `AppThrottlerGuard` as `APP_GUARD` (default `true`). Set `false` to register it
   * yourself — e.g. to control its position relative to other global guards.
   */
  globalGuard?: boolean;
}

/**
 * Redis-backed rate limiting for every replica (global module):
 * - ip: THROTTLE_IP_LIMIT per THROTTLE_IP_TTL_MS per client IP, charged by IpThrottlerGuard (import IpThrottlerModule BEFORE AuthModule);
 * - `user`: `THROTTLE_LIMIT` per `THROTTLE_TTL_MS`, one budget per user (else client IP) across routes;
 * - tenant: THROTTLE_TENANT_LIMIT per THROTTLE_TENANT_TTL_MS per active tenant (all its members);
 * - `route`: named policies (`@RateLimit`), declared by domains with `RateLimitModule.forFeature`;
 * - `auth`: credentials policies, sha256(email)+IP, with a per-account lockout reset on success;
 * - `@SkipRateLimit()` opts out; ops paths are exempt.
 * Requires `RedisModule` (global). Import `AuthModule` BEFORE this module so `req.user` is set.
 */
@Module({})
export class AppThrottlerModule {
  static forRootAsync(options: AppThrottlerModuleOptions = {}): DynamicModule {
    const skipIf = createThrottleSkipIf(options.exemptPaths ?? DEFAULT_THROTTLE_EXEMPT_PATHS);
    const providers: Provider[] = [
      AppThrottlerGuard,
      WsThrottlerGuard,
      RateLimitPolicyRegistry,
      RateLimitPolicyValidator,
      LockoutResetInterceptor,
      { provide: APP_INTERCEPTOR, useExisting: LockoutResetInterceptor },
    ];
    if (options.globalGuard ?? true) {
      providers.push({ provide: APP_GUARD, useExisting: AppThrottlerGuard });
    }
    return {
      module: AppThrottlerModule,
      global: true,
      imports: [
        DiscoveryModule,
        ConfigModule.forFeature(throttleConfig),
        // ThrottlerModule is @Global: its options + storage tokens are visible to every guard.
        ThrottlerModule.forRootAsync({
          imports: [ConfigModule.forFeature(throttleConfig), RateLimitMetricsModule],
          inject: [throttleConfig.KEY, REDIS_CLIENT, RedisKeyService, RATE_LIMIT_FAIL_OPEN_TOKEN],
          useFactory: (
            config: ThrottleConfig,
            redis: Redis,
            keys: RedisKeyService,
            failOpenTotal: { inc(labels: { throttler: string }): void },
          ): ThrottlerModuleOptions => ({
            throttlers: [
              { name: THROTTLER.IP, ttl: config.ipTtlMs, limit: config.ipLimit },
              { name: THROTTLER.USER, ttl: config.ttlMs, limit: config.limit },
              { name: THROTTLER.TENANT, ttl: config.tenantTtlMs, limit: config.tenantLimit },
              // Real values come from the route's @RateLimit policy (RateLimitGuardBase.bucketFor).
              { name: THROTTLER.ROUTE, ttl: config.ttlMs, limit: config.limit },
              // Real values come from the route's credentials policy; the account lockout rides on it.
              { name: THROTTLER.AUTH, ttl: config.ttlMs, limit: config.limit },
            ],
            storage: new RedisThrottlerStorage(redis, keys, {
              ...(options.failOpen === undefined ? {} : { failOpen: options.failOpen }),
              commandTimeoutMs: config.redisTimeoutMs,
              onFailOpen: (throttler) => failOpenTotal.inc({ throttler }),
            }),
            skipIf,
            ...(options.ignoreUserAgents ? { ignoreUserAgents: options.ignoreUserAgents } : {}),
          }),
        }),
      ],
      providers,
      exports: [AppThrottlerGuard, WsThrottlerGuard, RateLimitPolicyRegistry],
    };
  }
}

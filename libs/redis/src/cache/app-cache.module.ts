import { type CacheConfig, cacheConfig, type RedisConfig, redisConfig } from '@app/config';
import { createKeyv as createRedisKeyv, defaultReconnectStrategy } from '@keyv/redis';
import { CacheModule, type CacheModuleOptions } from '@nestjs/cache-manager';
import { type DynamicModule, Logger, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import type { Keyv } from 'keyv';
import { throttle } from 'lodash-es';
import { joinKey } from '../keys/key.util.js';
import { redactRedisUrl } from '../redis.factory.js';
import { createL1Store } from './bounded-ttl-keyv.js';
import {
  APP_CACHE_OPTIONS,
  type AppCacheModuleOptions,
  CACHE_KEY_NAMESPACE,
  type ResolvedAppCacheOptions,
} from './cache.constants.js';
import { AppCacheService } from './cache.service.js';

const ERROR_LOG_INTERVAL_MS = 10_000;

/** Keyv swallows store errors (cache = best effort); surface them, throttled, instead of silently. */
function logStoreErrors(store: Keyv, tier: string): void {
  const logger = new Logger(`AppCache:${tier}`);
  store.on(
    'error',
    throttle(
      (error: unknown): void => {
        logger.warn(
          `cache ${tier} error: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
      ERROR_LOG_INTERVAL_MS,
      { trailing: false },
    ),
  );
}

/** Builds the cache-manager options: L1 (in-process LRU, short TTL) → L2 (Redis, shared). */
export function createCacheOptions(cache: CacheConfig, redis: RedisConfig): CacheModuleOptions {
  const l1 = createL1Store({ ttlMs: cache.l1TtlMs, maxItems: cache.l1MaxItems });
  // @keyv/redis runs its own node-redis connection (not ioredis). The cache is best-effort: a Redis
  // outage must degrade to L1 + loader at full speed instead of failing or stalling requests —
  // throwOnConnectError=false (no throw), disableOfflineQueue (commands fail at once while the
  // client reconnects instead of queueing until Redis is back) and a reconnect strategy that never
  // gives up. `AppCacheService` opens the connection eagerly (`openRedisStores`) so the lazy
  // connect-with-timeout path of @keyv/redis is never taken on a request.
  const l2 = createRedisKeyv(
    {
      url: redis.url,
      disableOfflineQueue: true,
      socket: {
        connectTimeout: redis.connectTimeoutMs,
        reconnectStrategy: defaultReconnectStrategy,
      },
    },
    {
      namespace: joinKey(redis.keyPrefix, CACHE_KEY_NAMESPACE),
      keyPrefixSeparator: ':',
      throwOnConnectError: false,
      connectionTimeout: redis.connectTimeoutMs,
    },
  );
  logStoreErrors(l1, 'L1');
  logStoreErrors(l2, `L2(${redactRedisUrl(redis.url)})`);
  return {
    ttl: cache.ttlMs,
    stores: [l1, l2],
    // NOT nonBlocking: in cache-manager 7 it makes get() race all tiers, so an L1 miss (undefined)
    // wins over an L2 hit, and its fire-and-forget writes can surface as unhandled rejections.
  };
}

/**
 * Two-tier cache (blueprint §3.8): `CACHE_MANAGER` (cache-manager 7, global) + `AppCacheService`.
 * L1 entries are capped at `CACHE_L1_TTL_MS` and invalidated across replicas over Redis pub/sub;
 * L2 keys are `${REDIS_KEY_PREFIX}:cache:<key>`. Requires `RedisModule` (global).
 */
@Module({})
export class AppCacheModule {
  static forRootAsync(options: AppCacheModuleOptions = {}): DynamicModule {
    const resolved: ResolvedAppCacheOptions = {
      crossInstanceInvalidation: options.crossInstanceInvalidation ?? true,
    };
    return {
      module: AppCacheModule,
      global: true,
      imports: [
        CacheModule.registerAsync({
          isGlobal: true,
          imports: [ConfigModule.forFeature(cacheConfig), ConfigModule.forFeature(redisConfig)],
          inject: [cacheConfig.KEY, redisConfig.KEY],
          useFactory: createCacheOptions,
        }),
      ],
      providers: [{ provide: APP_CACHE_OPTIONS, useValue: resolved }, AppCacheService],
      exports: [AppCacheService],
    };
  }
}

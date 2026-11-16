/**
 * @platform/redis — ioredis 6 infrastructure shared by every service: global clients
 * (`RedisModule`), namespaced keys, distributed locks (`@WithLock` for crons), the two-tier cache
 * (in-process L1 + Redis L2), Redis-backed throttling, the BullMQ connection, the socket.io Redis
 * adapter and the readiness contributor. Test doubles live in `@platform/redis/testing`.
 */

// Re-exported for apps; prefer RateLimit/SkipRateLimit (they know every throttler name).
export { SkipThrottle, Throttle } from '@nestjs/throttler';
export { AppCacheModule, createCacheOptions } from './cache/app-cache.module.js';
export {
  BoundedTtlKeyv,
  capTtl,
  createL1Store,
  type L1StoreOptions,
} from './cache/bounded-ttl-keyv.js';
export {
  type AppCacheModuleOptions,
  CACHE_INVALIDATION_CHANNEL,
  CACHE_KEY_NAMESPACE,
} from './cache/cache.constants.js';
export { AppCacheService } from './cache/cache.service.js';
export { openRedisStores } from './cache/redis-store.util.js';
export { RedisHealthIndicator } from './health/redis.health.js';
export { hashTag, joinKey, REDIS_KEY_SEPARATOR, type RedisKeyPart } from './keys/key.util.js';
export { RedisKeyService } from './keys/redis-key.service.js';
export {
  DistributedLockService,
  isLockContention,
  type LockBackend,
  lockExtensionThreshold,
  REDLOCK_SETTINGS,
} from './lock/distributed-lock.service.js';
export { type LockResult, type LockSkipReason, MIN_LOCK_TTL_MS } from './lock/lock.types.js';
export { WithLock } from './lock/with-lock.decorator.js';
export {
  AppQueueModule,
  type AppQueueModuleOptions,
  createQueueOptions,
  DEFAULT_JOB_OPTIONS,
  DEFAULT_QUEUE_PREFIX,
} from './queue/app-queue.module.js';
export {
  InjectRedis,
  InjectRedisSubscriber,
  REDIS_CLIENT,
  REDIS_MODULE_OPTIONS,
  REDIS_SUBSCRIBER,
  REDLOCK,
} from './redis.constants.js';
export {
  attachRedisErrorLogger,
  closeRedisClient,
  createRedisClient,
  REDIS_MAX_RECONNECT_DELAY_MS,
  type RedisClientOverrides,
  reconnectOnReadonly,
  redactRedisUrl,
  redisRetryStrategy,
  waitForRedisReady,
} from './redis.factory.js';
export { RedisModule, type RedisModuleOptions, RedisShutdownHook } from './redis.module.js';
export {
  createRedisIoAdapter,
  DEFAULT_IO_SERVER_OPTIONS,
  type IoServerOptions,
  RedisIoAdapter,
  type RedisIoAdapterOptions,
} from './socket-io/redis-io.adapter.js';
export { AppThrottlerGuard } from './throttler/app-throttler.guard.js';
export {
  AppThrottlerModule,
  type AppThrottlerModuleOptions,
} from './throttler/app-throttler.module.js';
export { type ClientIpResolver, createClientIpResolver } from './throttler/client-ip.util.js';
export {
  credentialFrom,
  credentialHash,
  normalizeCredential,
} from './throttler/credential-tracker.util.js';
export { IpThrottlerGuard, IpThrottlerModule } from './throttler/ip-throttler.guard.js';
export { LockoutResetInterceptor } from './throttler/lockout-reset.interceptor.js';
export { RateLimit, SkipRateLimit } from './throttler/rate-limit.decorator.js';
export { type RateLimitFeatureOptions, RateLimitModule } from './throttler/rate-limit.module.js';
export { RateLimitCharger } from './throttler/rate-limit-charger.js';
export {
  type RateLimitBucket,
  RateLimitGuardBase,
  type RateLimitSubject,
} from './throttler/rate-limit-guard.base.js';
export {
  collectDecision,
  formatRateLimit,
  formatRateLimitPolicy,
  policyItemName,
  RATE_LIMIT_HEADER_ORDER,
  type RateLimitDecision,
} from './throttler/rate-limit-headers.js';
export { rateLimitKey } from './throttler/rate-limit-key.util.js';
export {
  RATE_LIMIT_POLICY_NAME,
  type RateLimitKeyKind,
  type RateLimitLockout,
  type RateLimitPolicy,
  RateLimitPolicyRegistry,
} from './throttler/rate-limit-policy.js';
export {
  DEFAULT_THROTTLE_COMMAND_TIMEOUT_MS,
  FAIL_CLOSED_THROTTLERS,
  msToSeconds,
  RATE_LIMIT_FAIL_OPEN_TOKEN,
  RATE_LIMIT_FAIL_OPEN_TOTAL,
  RedisThrottlerStorage,
  type RedisThrottlerStorageOptions,
  type ThrottlerStorageRecord,
} from './throttler/redis-throttler.storage.js';
export {
  THROTTLE_COMMAND,
  THROTTLE_SCRIPT,
  type ThrottleReply,
} from './throttler/throttle.command.js';
export {
  DEFAULT_THROTTLE_EXEMPT_PATHS,
  GLOBAL_SCOPE,
  RATE_LIMIT_POLICY_KEY,
  RATE_LIMIT_THROTTLERS,
  THROTTLER,
  type ThrottlerName,
} from './throttler/throttle.constants.js';
export { createThrottleSkipIf, isThrottleExemptPath } from './throttler/throttle-exempt.util.js';
export {
  authenticatedTenantId,
  authenticatedUserId,
  throttleTracker,
} from './throttler/throttle-tracker.util.js';
export { WsThrottlerGuard } from './throttler/ws-throttler.guard.js';

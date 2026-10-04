import { Inject } from '@nestjs/common';

/** Main ioredis connection: commands, cache helpers, locks, rate limiting, denylist (auto-pipelined). */
export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

/**
 * Dedicated connection for SUBSCRIBE/PSUBSCRIBE. It is created with `lazyConnect`, so services that
 * never subscribe never open it.
 */
export const REDIS_SUBSCRIBER = Symbol('REDIS_SUBSCRIBER');

/** The `@sesamecare-oss/redlock` instance behind `DistributedLockService` (overridable in tests). */
export const REDLOCK = Symbol('REDLOCK');

/** `RedisModuleOptions` passed to `RedisModule.forRootAsync()`. */
export const REDIS_MODULE_OPTIONS = Symbol('REDIS_MODULE_OPTIONS');

/** `@InjectRedis() private readonly redis: Redis` (import `type { Redis }` from ioredis). */
export const InjectRedis = (): PropertyDecorator & ParameterDecorator => Inject(REDIS_CLIENT);

/** `@InjectRedisSubscriber() private readonly sub: Redis` — never issue regular commands on it. */
export const InjectRedisSubscriber = (): PropertyDecorator & ParameterDecorator =>
  Inject(REDIS_SUBSCRIBER);

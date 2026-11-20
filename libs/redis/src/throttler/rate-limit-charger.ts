import { Injectable, Optional } from '@nestjs/common';
import {
  DEFAULT_IPV6_SUBNET_PREFIX,
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  type ThrottlerModuleOptions,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import type { RateLimitBucket } from './rate-limit-guard.base.js';
import type { RateLimitDecision } from './rate-limit-headers.js';
import { rateLimitKey } from './rate-limit-key.util.js';
import { recordRateLimitDecision } from './rate-limit-metrics.js';
import type { ThrottlerStorageRecord } from './redis-throttler.storage.js';
import { throttleTracker } from './throttle-tracker.util.js';

interface WeightedStorage extends ThrottlerStorage {
  incrementBy(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
    weight: number,
  ): Promise<ThrottlerStorageRecord>;
}

const isWeighted = (storage: ThrottlerStorage | WeightedStorage): storage is WeightedStorage =>
  typeof Reflect.get(storage, 'incrementBy') === 'function';

/**
 * Charges a bucket outside the guard pipeline (GraphQL plugin, graphql-ws), by weight, and counts
 * the decision in `rate_limit_decisions_total`.
 */
@Injectable()
export class RateLimitCharger {
  // The union lets callers (and tests) hand over a storage that has `incrementBy`; DI uses the token.
  private readonly ipv6SubnetPrefix: number;

  constructor(
    @InjectThrottlerStorage() private readonly storage: ThrottlerStorage | WeightedStorage,
    // Explicit token: a `T | undefined` parameter type is emitted as `Object` in design:paramtypes.
    @Optional() @InjectThrottlerOptions() options?: ThrottlerModuleOptions,
  ) {
    const prefix = Array.isArray(options) ? undefined : options?.ipv6SubnetPrefix;
    this.ipv6SubnetPrefix = prefix ?? DEFAULT_IPV6_SUBNET_PREFIX;
  }

  /**
   * The tracker the guards would use: `user:<id>`, else `ip:<address>` with IPv6 collapsed to the
   * same subnet prefix as `ThrottlerGuard` (default /64), so rotating addresses in one /64 does not
   * buy a fresh bucket.
   */
  trackerFor(user: unknown, ip: unknown): string {
    return throttleTracker(user, ip, this.ipv6SubnetPrefix);
  }

  async charge(
    bucket: RateLimitBucket,
    weight = 1,
  ): Promise<{ record: ThrottlerStorageRecord; decision: RateLimitDecision }> {
    const key = rateLimitKey(bucket.throttler, bucket.scope, bucket.tracker);
    const storage = this.storage;
    const record = isWeighted(storage)
      ? await storage.incrementBy(
          key,
          bucket.ttlMs,
          bucket.limit,
          bucket.blockMs,
          bucket.throttler,
          weight,
        )
      : await storage.increment(key, bucket.ttlMs, bucket.limit, bucket.blockMs, bucket.throttler);
    const decision: RateLimitDecision = {
      throttler: bucket.throttler,
      scope: bucket.scope,
      limit: bucket.limit,
      ttlMs: bucket.ttlMs,
      remaining: record.isBlocked ? 0 : Math.max(0, bucket.limit - record.totalHits),
      resetSeconds: record.isBlocked ? record.timeToBlockExpire : record.timeToExpire,
      blocked: record.isBlocked,
      retryAfterSeconds: record.isBlocked ? record.timeToBlockExpire : 0,
    };
    // One count per charge whatever the weight; callers must not also pass this decision to a
    // guard's recordDecision (they write headers with collectDecision), so it is counted once.
    recordRateLimitDecision(decision);
    return { record, decision };
  }
}

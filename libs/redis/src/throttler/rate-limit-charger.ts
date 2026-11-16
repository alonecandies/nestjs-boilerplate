import { Injectable } from '@nestjs/common';
import { InjectThrottlerStorage, type ThrottlerStorage } from '@nestjs/throttler';
import type { RateLimitBucket } from './rate-limit-guard.base.js';
import type { RateLimitDecision } from './rate-limit-headers.js';
import { rateLimitKey } from './rate-limit-key.util.js';
import type { ThrottlerStorageRecord } from './redis-throttler.storage.js';

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

/** Charges a bucket outside the guard pipeline (GraphQL plugin, graphql-ws), by weight. */
@Injectable()
export class RateLimitCharger {
  // The union lets callers (and tests) hand over a storage that has `incrementBy`; DI uses the token.
  constructor(
    @InjectThrottlerStorage() private readonly storage: ThrottlerStorage | WeightedStorage,
  ) {}

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
    return { record, decision };
  }
}

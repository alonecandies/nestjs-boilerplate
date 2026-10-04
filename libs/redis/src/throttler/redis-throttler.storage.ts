import { ServiceUnavailableException } from '@app/common';
import { Logger } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { Redis } from 'ioredis';
import { throttle } from 'lodash-es';
import { hashTag } from '../keys/key.util.js';
import type { RedisKeyService } from '../keys/redis-key.service.js';
import { defineThrottleCommand } from './throttle.command.js';

/** `ThrottlerStorageRecord` is not re-exported by @nestjs/throttler's barrel — derive it. */
export type ThrottlerStorageRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>;

export interface RedisThrottlerStorageOptions {
  /**
   * What to do when Redis cannot be reached. `true` (default): let the request through and log
   * (rate limiting is a protection, not a correctness feature — a Redis blip must not turn every
   * request into a 5xx). `false`: reject with 503 (`ServiceUnavailableException`).
   */
  failOpen?: boolean;
}

/** The storage contract reports seconds (used for `Retry-After` / `X-RateLimit-Reset`). */
export const msToSeconds = (ms: number): number => Math.max(0, Math.ceil(ms / 1_000));

const FAILURE_LOG_INTERVAL_MS = 10_000;

/**
 * Distributed `ThrottlerStorage`: ONE Lua call per throttled request (EVALSHA via
 * `defineCommand`, see `THROTTLE_SCRIPT`), so limits hold across every replica. Keys:
 * `${prefix}:throttle:{${throttlerName}:${key}}:hits|block` — `key` is already the guard's
 * sha256(class + handler + tracker) (no PII in Redis), and the hash tag keeps both keys in one
 * Redis Cluster slot.
 *
 * Built by `AppThrottlerModule` (not a DI provider) because it takes plain options.
 */
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(RedisThrottlerStorage.name);
  private readonly failOpen: boolean;
  private readonly reportFailure: (error: unknown) => void;

  constructor(
    private readonly redis: Redis,
    private readonly keys: RedisKeyService,
    options: RedisThrottlerStorageOptions = {},
  ) {
    this.failOpen = options.failOpen ?? true;
    // One line per 10s during an outage instead of one per request.
    this.reportFailure = throttle(
      (error: unknown): void => {
        const reason = error instanceof Error ? error.message : String(error);
        this.logger.warn(`rate limiting bypassed — Redis unavailable (${reason})`);
      },
      FAILURE_LOG_INTERVAL_MS,
      { trailing: false },
    );
    defineThrottleCommand(redis);
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    // Fast path while disconnected: don't park the request in ioredis' offline queue (it would
    // wait for up to maxRetriesPerRequest reconnect attempts before failing).
    if (this.redis.status !== 'ready') {
      return this.onFailure(new Error(`connection is ${this.redis.status}`), ttl);
    }
    const base = this.keys.key('throttle', hashTag(`${throttlerName}:${key}`));
    try {
      // PEXPIRE / SET PX reject non-integers — resolvable ttl functions may return fractions.
      const [totalHits, timeToExpireMs, blocked, timeToBlockExpireMs] =
        await this.redis.appThrottleHit(
          `${base}:hits`,
          `${base}:block`,
          Math.max(1, Math.ceil(ttl)),
          limit,
          Math.ceil(blockDuration),
        );
      return {
        totalHits,
        timeToExpire: msToSeconds(timeToExpireMs),
        isBlocked: blocked === 1,
        timeToBlockExpire: msToSeconds(timeToBlockExpireMs),
      };
    } catch (error) {
      return this.onFailure(error, ttl);
    }
  }

  private onFailure(error: unknown, ttl: number): ThrottlerStorageRecord {
    if (!this.failOpen) {
      throw new ServiceUnavailableException('Rate limiter is temporarily unavailable', {
        cause: error,
      });
    }
    this.reportFailure(error);
    return { totalHits: 0, timeToExpire: msToSeconds(ttl), isBlocked: false, timeToBlockExpire: 0 };
  }
}

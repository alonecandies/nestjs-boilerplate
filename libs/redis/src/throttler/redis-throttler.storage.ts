import { Logger } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import { ServiceUnavailableException } from '@platform/common';
import type { Redis } from 'ioredis';
import { throttle } from 'lodash-es';
import { hashTag } from '../keys/key.util.js';
import type { RedisKeyService } from '../keys/redis-key.service.js';
import { defineThrottleCommand } from './throttle.command.js';

/** `ThrottlerStorageRecord` is not re-exported by @nestjs/throttler's barrel — derive it. */
export type ThrottlerStorageRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>;

/** Throttlers that refuse (503) instead of letting traffic through when Redis is unusable. */
export const FAIL_CLOSED_THROTTLERS: ReadonlySet<string> = new Set(['auth', 'lockout']);

export const DEFAULT_THROTTLE_COMMAND_TIMEOUT_MS = 250;

export const RATE_LIMIT_FAIL_OPEN_TOTAL = 'rate_limit_fail_open_total';
/** DI token of the counter (`makeCounterProvider` registers `PROM_METRIC_<NAME>`). */
export const RATE_LIMIT_FAIL_OPEN_TOKEN = `PROM_METRIC_${RATE_LIMIT_FAIL_OPEN_TOTAL.toUpperCase()}`;

export interface RedisThrottlerStorageOptions {
  /**
   * What to do when Redis cannot be reached or does not answer within `commandTimeoutMs`.
   * Default: fail OPEN for budgets (ip/user/route/tenant: a protection, not a correctness feature)
   * and CLOSED (503) for `auth`/`lockout` (an unlimited credential endpoint is a brute-force door).
   * A boolean applies to every throttler.
   */
  failOpen?: boolean | ((throttlerName: string) => boolean);
  /** Upper bound for one throttle command (default 250 ms). */
  commandTimeoutMs?: number;
  /** Called once per request that was let through because of a failure (metrics). */
  onFailOpen?: (throttlerName: string) => void;
}

class ThrottleTimeoutError extends Error {}

/** The storage contract reports seconds (used for `Retry-After` and the IETF `RateLimit` `t=`). */
export const msToSeconds = (ms: number): number => Math.max(0, Math.ceil(ms / 1_000));

const FAILURE_LOG_INTERVAL_MS = 10_000;

/**
 * Distributed `ThrottlerStorage` that fails open per throttler (see
 * `RedisThrottlerStorageOptions.failOpen`): ONE Lua call per throttled request (EVALSHA via
 * `defineCommand`, see `THROTTLE_SCRIPT`), so limits hold across every replica. Keys:
 * `${prefix}:throttle:{${throttlerName}:${key}}:hits|block` — `key` is already the guard's
 * sha256(class + handler + tracker) (no PII in Redis), and the hash tag keeps both keys in one
 * Redis Cluster slot.
 *
 * Built by `AppThrottlerModule` (not a DI provider) because it takes plain options.
 */
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(RedisThrottlerStorage.name);
  private readonly failOpen: (throttlerName: string) => boolean;
  private readonly commandTimeoutMs: number;
  private readonly onFailOpen: ((throttlerName: string) => void) | undefined;
  private readonly reportFailure: (error: unknown) => void;

  constructor(
    private readonly redis: Redis,
    private readonly keys: RedisKeyService,
    options: RedisThrottlerStorageOptions = {},
  ) {
    const failOpen = options.failOpen;
    this.failOpen =
      typeof failOpen === 'function'
        ? failOpen
        : failOpen === undefined
          ? (name: string): boolean => !FAIL_CLOSED_THROTTLERS.has(name)
          : (): boolean => failOpen;
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_THROTTLE_COMMAND_TIMEOUT_MS;
    this.onFailOpen = options.onFailOpen;
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

  increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    return this.incrementBy(key, ttl, limit, blockDuration, throttlerName, 1);
  }

  /** `increment` with a weight (GraphQL cost): the window counter grows by `weight` in one call. */
  async incrementBy(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
    weight: number,
  ): Promise<ThrottlerStorageRecord> {
    // Fast path while disconnected: don't park the request in ioredis' offline queue (it would
    // wait for up to maxRetriesPerRequest reconnect attempts before failing).
    if (this.redis.status !== 'ready') {
      return this.onFailure(new Error(`connection is ${this.redis.status}`), ttl, throttlerName);
    }
    const base = this.keys.key('throttle', hashTag(`${throttlerName}:${key}`));
    try {
      // PEXPIRE / SET PX reject non-integers — resolvable ttl functions may return fractions.
      const [totalHits, timeToExpireMs, blocked, timeToBlockExpireMs] = await this.withTimeout(
        this.redis.appThrottleHit(
          `${base}:hits`,
          `${base}:block`,
          Math.max(1, Math.ceil(ttl)),
          limit,
          Math.ceil(blockDuration),
          Math.max(1, Math.ceil(weight)),
        ),
      );
      return {
        totalHits,
        timeToExpire: msToSeconds(timeToExpireMs),
        isBlocked: blocked === 1,
        timeToBlockExpire: msToSeconds(timeToBlockExpireMs),
      };
    } catch (error) {
      return this.onFailure(error, ttl, throttlerName);
    }
  }

  /** Deletes one bucket's hit counter (not its block): clears a lockout after a success. Best effort. */
  async reset(key: string, throttlerName: string): Promise<void> {
    if (this.redis.status !== 'ready') return;
    const base = this.keys.key('throttle', hashTag(`${throttlerName}:${key}`));
    try {
      await this.withTimeout(this.redis.del(`${base}:hits`));
    } catch {
      return;
    }
  }

  private async withTimeout<T>(command: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new ThrottleTimeoutError(`no reply within ${this.commandTimeoutMs} ms`)),
        this.commandTimeoutMs,
      );
      timer.unref();
    });
    try {
      return await Promise.race([command, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private onFailure(error: unknown, ttl: number, throttlerName: string): ThrottlerStorageRecord {
    if (!this.failOpen(throttlerName)) {
      throw new ServiceUnavailableException('Rate limiter is temporarily unavailable', {
        cause: error,
      });
    }
    this.reportFailure(error);
    this.onFailOpen?.(throttlerName);
    return { totalHits: 0, timeToExpire: msToSeconds(ttl), isBlocked: false, timeToBlockExpire: 0 };
  }
}

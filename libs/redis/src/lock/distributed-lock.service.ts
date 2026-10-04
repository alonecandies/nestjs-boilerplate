import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  ExecutionError,
  type Redlock,
  ResourceLockedError,
  type Settings,
} from '@sesamecare-oss/redlock';
import { clamp, flatMap, isString } from 'lodash-es';
import { RedisKeyService } from '../keys/redis-key.service.js';
import { REDLOCK } from '../redis.constants.js';
import { type LockResult, MIN_LOCK_TTL_MS } from './lock.types.js';
import { type LockRunner, registerLockRunner } from './lock-registry.js';

/** The part of redlock the service uses — lets tests substitute a fake. */
export type LockBackend = Pick<Redlock, 'using'>;

/** Auto-extend when `ttl/4` (50 ms … 5 s) is left: enough margin to retry through a Redis blip. */
export function lockExtensionThreshold(ttlMs: number): number {
  return clamp(Math.floor(ttlMs / 4), 50, 5_000);
}

export function assertLockArgs(resource: string, ttlMs: number): void {
  if (!isString(resource) || resource.length === 0) {
    throw new TypeError('Lock resource must be a non-empty string');
  }
  if (!Number.isInteger(ttlMs) || ttlMs < MIN_LOCK_TTL_MS) {
    throw new RangeError(`Lock TTL must be an integer >= ${MIN_LOCK_TTL_MS}ms, received ${ttlMs}`);
  }
}

/**
 * True when every vote against the acquisition was "already locked" (another replica holds the
 * lock) — as opposed to Redis being unreachable. With `retryCount: 0` contention surfaces as an
 * `ExecutionError` whose attempts carry `ResourceLockedError` votes.
 */
export async function isLockContention(error: unknown): Promise<boolean> {
  if (error instanceof ResourceLockedError) return true;
  if (!(error instanceof ExecutionError)) return false;
  try {
    const stats = await Promise.all(error.attempts);
    const reasons = flatMap(stats, (attempt) => [...attempt.votesAgainst.values()]);
    return reasons.length > 0 && reasons.every((reason) => reason instanceof ResourceLockedError);
  } catch {
    return false;
  }
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * "Run on exactly one replica" primitive for cron jobs and other singleton work, on top of
 * `@sesamecare-oss/redlock` with `retryCount: 0`: if another replica holds the lock we SKIP instead
 * of waiting. While `fn` runs the lock is auto-extended; if an extension fails (Redis failover) the
 * `AbortSignal` passed to `fn` aborts — long jobs should check `signal.aborted` between batches.
 *
 * Keys: `${prefix}:lock:${resource}`. Never call `redlock.quit()` — it would QUIT the shared client.
 */
@Injectable()
export class DistributedLockService implements LockRunner, OnModuleInit {
  private readonly logger = new Logger(DistributedLockService.name);

  constructor(
    @Inject(REDLOCK) private readonly redlock: LockBackend,
    private readonly keys: RedisKeyService,
  ) {}

  onModuleInit(): void {
    registerLockRunner(this);
  }

  /**
   * Runs `fn` while holding `resource`. Resolves `{ acquired: false, reason }` when the lock is held
   * elsewhere (`'held'`, logged at debug) or Redis is unavailable (`'error'`, logged at warn).
   * Errors thrown by `fn` propagate (the lock is released first).
   */
  async using<T>(
    resource: string,
    ttlMs: number,
    fn: (signal: AbortSignal) => Promise<T>,
  ): Promise<LockResult<T>> {
    assertLockArgs(resource, ttlMs);
    const key = this.keys.key('lock', resource);
    // Boxed so `undefined` results are distinguishable from "never ran".
    const state: { started: boolean; outcome?: { value: T }; failure?: { error: unknown } } = {
      started: false,
    };
    try {
      await this.redlock.using(
        [key],
        ttlMs,
        { automaticExtensionThreshold: lockExtensionThreshold(ttlMs) },
        async (signal) => {
          state.started = true;
          try {
            state.outcome = { value: await fn(signal) };
          } catch (error) {
            state.failure = { error };
            throw error;
          }
        },
      );
    } catch (error) {
      if (!state.started) return this.skipped(resource, error);
      // redlock releases in `finally`; a failing release must not mask the routine's own error.
      if (state.failure) throw state.failure.error;
      // The work succeeded; only the release failed. The key still expires after `ttlMs`.
      this.logger.warn(
        `lock "${resource}": release failed (${errorMessage(error)}); expires in ${ttlMs}ms`,
      );
    }
    if (!state.outcome) throw new Error(`lock "${resource}": routine did not complete`);
    return { acquired: true, result: state.outcome.value };
  }

  private async skipped(resource: string, error: unknown): Promise<LockResult<never>> {
    if (await isLockContention(error)) {
      this.logger.debug(`lock "${resource}" is held by another instance — skipped`);
      return { acquired: false, reason: 'held' };
    }
    this.logger.warn(`lock "${resource}" could not be acquired (${errorMessage(error)}) — skipped`);
    return { acquired: false, reason: 'error' };
  }
}

/** Redlock defaults: single Redis primary (quorum of 1), never wait for a busy lock. */
export const REDLOCK_SETTINGS: Readonly<Settings> = {
  driftFactor: 0.01,
  retryCount: 0,
  retryDelay: 200,
  retryJitter: 100,
  automaticExtensionThreshold: 500,
};

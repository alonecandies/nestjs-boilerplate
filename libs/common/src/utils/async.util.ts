import { setTimeout as delay } from 'node:timers/promises';
import { clamp, random, times } from 'lodash-es';
import { OperationTimeoutException } from '../errors/domain.exception.js';

/** Promise-based sleep that rejects with an `AbortError` when `signal` aborts (graceful shutdown). */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return delay(ms, undefined, signal ? { signal } : undefined);
}

export interface RetryOptions {
  /** Retries AFTER the first attempt (total attempts = retries + 1). Default 3. */
  retries?: number;
  /** Delay before the first retry. Default 100 ms. */
  minDelayMs?: number;
  /** Upper bound for any single delay. Default 10 000 ms. */
  maxDelayMs?: number;
  /** Exponential growth factor. Default 2. */
  factor?: number;
  /**
   * Randomize each delay in `[minDelayMs, computedDelay]` ("full jitter") so a fleet of replicas
   * doesn't retry in lock-step against a recovering dependency. Default true.
   */
  jitter?: boolean;
  /** Return false to fail fast (e.g. on 4xx / validation errors). Default: always retry. */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  /** Hook for logging/metrics before each retry sleep. */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  /** Aborts the pending sleep and stops retrying. */
  signal?: AbortSignal;
}

/** Delay (ms) before retry number `attempt` (1-based) — exposed for tests and custom schedulers. */
export function computeBackoffDelay(
  attempt: number,
  options: Pick<RetryOptions, 'minDelayMs' | 'maxDelayMs' | 'factor' | 'jitter'> = {},
): number {
  const { minDelayMs = 100, maxDelayMs = 10_000, factor = 2, jitter = true } = options;
  const exponential = clamp(minDelayMs * factor ** (attempt - 1), minDelayMs, maxDelayMs);
  return jitter ? random(minDelayMs, exponential) : exponential;
}

/**
 * Retries `fn` with capped exponential backoff + jitter. `fn` receives the 1-based attempt number.
 * Rethrows the last error once retries are exhausted or `shouldRetry` returns false.
 */
export async function retry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const { retries = 3, shouldRetry, onRetry, signal } = options;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt > retries || signal?.aborted || (shouldRetry && !shouldRetry(error, attempt))) {
        throw error;
      }
      const delayMs = computeBackoffDelay(attempt, options);
      onRetry?.(error, attempt, delayMs);
      await sleep(delayMs, signal);
    }
  }
}

/**
 * `Promise.all` over `items` with at most `concurrency` calls in flight; results keep input order.
 * Fail-fast: the first rejection rejects the whole call and no new items are started (in-flight
 * ones finish in the background). Use it to bound fan-out to DBs / upstream APIs.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError(`concurrency must be a positive integer, received ${concurrency}`);
  }
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await fn(items[index] as T, index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(times(Math.min(concurrency, items.length), worker));
  return results;
}

/**
 * Rejects with `OperationTimeoutException` (504) if `promise` doesn't settle within `ms`.
 * The underlying work is NOT cancelled — pass an `AbortSignal` to it when it supports one.
 */
export async function withTimeout<T>(
  promise: PromiseLike<T>,
  ms: number,
  message?: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new OperationTimeoutException(message ?? `Operation timed out after ${ms}ms`, {
          details: { timeoutMs: ms },
        }),
      );
    }, ms);
    timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

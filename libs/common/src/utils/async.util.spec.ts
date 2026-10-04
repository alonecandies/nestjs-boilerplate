import { describe, expect, it, vi } from 'vitest';
import { OperationTimeoutException } from '../errors/domain.exception.js';
import {
  computeBackoffDelay,
  mapWithConcurrency,
  retry,
  sleep,
  withTimeout,
} from './async.util.js';

describe('sleep', () => {
  it('resolves after the delay and rejects on abort', async () => {
    await expect(sleep(1)).resolves.toBeUndefined();
    const controller = new AbortController();
    const pending = sleep(10_000, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('computeBackoffDelay', () => {
  it('grows exponentially and is capped without jitter', () => {
    const opts = { minDelayMs: 100, maxDelayMs: 1_000, factor: 2, jitter: false };
    expect([1, 2, 3, 4, 5].map((a) => computeBackoffDelay(a, opts))).toEqual([
      100, 200, 400, 800, 1_000,
    ]);
  });

  it('keeps jittered delays within [min, computed]', () => {
    for (let i = 0; i < 50; i++) {
      const delay = computeBackoffDelay(3, { minDelayMs: 10, maxDelayMs: 1_000, factor: 2 });
      expect(delay).toBeGreaterThanOrEqual(10);
      expect(delay).toBeLessThanOrEqual(40);
    }
  });
});

describe('retry', () => {
  it('retries until success and reports each retry', async () => {
    const onRetry = vi.fn();
    const fn = vi
      .fn<(attempt: number) => Promise<string>>()
      .mockRejectedValueOnce(new Error('a'))
      .mockRejectedValueOnce(new Error('b'))
      .mockResolvedValue('ok');
    await expect(retry(fn, { retries: 3, minDelayMs: 1, maxDelayMs: 2, onRetry })).resolves.toBe(
      'ok',
    );
    expect(fn).toHaveBeenCalledTimes(3);
    expect(fn.mock.calls.map(([attempt]) => attempt)).toEqual([1, 2, 3]);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('rethrows the last error once retries are exhausted', async () => {
    const fn = vi.fn(async () => {
      throw new Error('down');
    });
    await expect(retry(fn, { retries: 2, minDelayMs: 1, maxDelayMs: 1 })).rejects.toThrow('down');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('fails fast when shouldRetry returns false', async () => {
    const fn = vi.fn(async () => {
      throw new Error('fatal');
    });
    await expect(retry(fn, { retries: 5, shouldRetry: () => false })).rejects.toThrow('fatal');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('mapWithConcurrency', () => {
  it('bounds concurrency and preserves input order', async () => {
    let inFlight = 0;
    let peak = 0;
    const result = await mapWithConcurrency([5, 1, 4, 2, 3], 2, async (n, index) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await sleep(n);
      inFlight--;
      return `${index}:${n}`;
    });
    expect(result).toEqual(['0:5', '1:1', '2:4', '3:2', '4:3']);
    expect(peak).toBe(2);
  });

  it('rejects on the first failure and stops scheduling new items', async () => {
    const seen: number[] = [];
    await expect(
      mapWithConcurrency([1, 2, 3, 4, 5, 6], 1, async (n) => {
        seen.push(n);
        if (n === 2) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow('boom');
    expect(seen).toEqual([1, 2]);
  });

  it('handles empty input and validates concurrency', async () => {
    await expect(mapWithConcurrency([], 3, async () => 1)).resolves.toEqual([]);
    await expect(mapWithConcurrency([1], 0, async () => 1)).rejects.toThrow(RangeError);
  });
});

describe('withTimeout', () => {
  it('passes through fast results', async () => {
    await expect(withTimeout(Promise.resolve(7), 50)).resolves.toBe(7);
  });

  it('rejects slow work with OperationTimeoutException', async () => {
    const error: unknown = await withTimeout(sleep(1_000), 5, 'too slow').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OperationTimeoutException);
    expect(error).toMatchObject({ message: 'too slow', httpStatus: 504, code: 'TIMEOUT' });
  });
});

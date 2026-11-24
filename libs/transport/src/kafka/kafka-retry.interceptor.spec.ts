import {
  type ArgumentsHost,
  type CallHandler,
  type ExecutionContext,
  Logger,
} from '@nestjs/common';
import { KafkaContext, KafkaRetriableException } from '@nestjs/microservices';
import {
  DomainValidationException,
  OperationTimeoutException,
  ServiceUnavailableException,
} from '@platform/common';
import { catchError, defer, lastValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { InvalidEventException } from './kafka.errors.js';
import { KAFKA_HEARTBEAT_INTERVAL_MS } from './kafka.options.js';
import { KafkaDeadLetterFilter } from './kafka-dead-letter.filter.js';
import {
  DEFAULT_KAFKA_RETRY_OPTIONS,
  isRetriableKafkaHandlerError,
  KafkaRetryInterceptor,
} from './kafka-retry.interceptor.js';

/** `heartbeat` is what kafkajs hands `eachMessage` (`undefined`: a context without one). */
function kafkaContext(
  heartbeat: (() => Promise<void>) | undefined = () => Promise.resolve(),
): KafkaContext {
  const message = { key: 'k', value: {}, headers: {}, offset: '7' };
  return new KafkaContext([
    message as never,
    0,
    'fixture.user-registered.v1',
    {} as never,
    heartbeat,
    {} as never,
  ]);
}

function executionContext(type: string, rpcContext: unknown): ExecutionContext {
  return {
    getType: () => type,
    switchToRpc: () => ({ getContext: () => rpcContext, getData: () => ({}) }),
  } as unknown as ExecutionContext;
}

/** A handler that fails with `errors[i]` on attempt i and succeeds once they run out. */
function flakyHandler(errors: Error[]): { next: CallHandler; attempts: () => number } {
  let attempts = 0;
  const run = vi.fn(() => {
    const error = errors[attempts];
    attempts += 1;
    return error === undefined ? Promise.resolve('ok') : Promise.reject(error);
  });
  return { next: { handle: () => defer(run) }, attempts: () => attempts };
}

const fast = new KafkaRetryInterceptor({ minDelayMs: 1, maxDelayMs: 2 });

/** The WARN line logged before retry `attempt` of the 4 (any backoff delay). */
const retryWarning = (attempt: number, cause: string) =>
  expect.stringMatching(
    new RegExp(
      `^Retrying fixture\\.user-registered\\.v1\\[0\\]@7 in \\d+ ms \\(attempt ${attempt}/4\\) after ${cause}$`,
    ),
  );

describe('KafkaRetryInterceptor', () => {
  it('retries a transient failure and succeeds without reaching the filter', async () => {
    const { next, attempts } = flakyHandler([
      new Error('connect ECONNREFUSED'),
      new Error('again'),
    ]);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await expect(
      lastValueFrom(fast.intercept(executionContext('rpc', kafkaContext()), next)),
    ).resolves.toBe('ok');
    expect(attempts()).toBe(3);
    expect(warn.mock.calls).toEqual([
      [retryWarning(2, 'Error: connect ECONNREFUSED')],
      [retryWarning(3, 'Error: again')],
    ]);
  });

  it('gives up after the configured attempts and surfaces the last error (then dead-lettered)', async () => {
    const transient = new ServiceUnavailableException('cassandra down');
    const { next, attempts } = flakyHandler(Array.from({ length: 10 }, () => transient));
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await expect(
      lastValueFrom(fast.intercept(executionContext('rpc', kafkaContext()), next)),
    ).rejects.toBe(transient);
    expect(attempts()).toBe(DEFAULT_KAFKA_RETRY_OPTIONS.attempts);
    expect(warn.mock.calls).toEqual(
      [2, 3, 4].map((attempt) => [retryWarning(attempt, 'SERVICE_UNAVAILABLE: cassandra down')]),
    );
  });

  it.each([
    ['InvalidEventException (pipe)', new InvalidEventException('bad envelope')],
    ['a 4xx DomainException', new DomainValidationException('nope')],
    ['a ZodError', new z.ZodError([])],
    ['KafkaRetriableException (kafkajs redelivers it)', new KafkaRetriableException('later')],
  ])('does not retry %s', async (_label, error) => {
    const { next, attempts } = flakyHandler([error]);
    await expect(
      lastValueFrom(fast.intercept(executionContext('rpc', kafkaContext()), next)),
    ).rejects.toBe(error);
    expect(attempts()).toBe(1);
  });

  it('leaves non-Kafka contexts alone', async () => {
    for (const [type, rpcContext] of [
      ['http', undefined],
      ['rpc', { grpc: true }],
    ] as const) {
      const { next, attempts } = flakyHandler([new Error('x')]);
      await expect(
        lastValueFrom(fast.intercept(executionContext(type, rpcContext), next)),
      ).rejects.toThrow('x');
      expect(attempts()).toBe(1);
    }
  });

  it('can be disabled with attempts: 1', async () => {
    const { next, attempts } = flakyHandler([new Error('x')]);
    const disabled = new KafkaRetryInterceptor({ attempts: 1 });
    await expect(
      lastValueFrom(disabled.intercept(executionContext('rpc', kafkaContext()), next)),
    ).rejects.toThrow('x');
    expect(attempts()).toBe(1);
  });

  it('keeps the total default backoff far below the consumer session timeout', () => {
    const { attempts, maxDelayMs } = DEFAULT_KAFKA_RETRY_OPTIONS;
    expect((attempts - 1) * maxDelayMs).toBeLessThan(30_000 / 4);
  });
});

describe('KafkaRetryInterceptor: one budget for all of a message, heartbeats meanwhile', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** The outcome of `promise`, readable synchronously once the fake clock has moved. */
  function watch<T>(promise: Promise<T>): { settled: boolean; value?: T; error?: unknown } {
    const state: { settled: boolean; value?: T; error?: unknown } = { settled: false };
    promise.then(
      (value) => Object.assign(state, { settled: true, value }),
      (error: unknown) => Object.assign(state, { settled: true, error }),
    );
    return state;
  }

  const never = (): { next: CallHandler; calls: () => number } => {
    const run = vi.fn(() => new Promise<never>(() => undefined));
    return { next: { handle: () => defer(run) }, calls: () => run.mock.calls.length };
  };
  const after = (ms: number, outcome: () => Promise<unknown>) => () =>
    new Promise((resolve) => setTimeout(resolve, ms)).then(outcome);

  it('rejects a handler that never settles at budgetMs, heartbeating at the start and every 3 s', async () => {
    const heartbeat = vi.fn(() => Promise.resolve());
    const { next, calls } = never();
    const { budgetMs } = DEFAULT_KAFKA_RETRY_OPTIONS;
    expect(budgetMs).toBe(40_000);
    expect(KAFKA_HEARTBEAT_INTERVAL_MS).toBe(3_000);

    const outcome = watch(
      lastValueFrom(
        new KafkaRetryInterceptor().intercept(
          executionContext('rpc', kafkaContext(heartbeat)),
          next,
        ),
      ),
    );
    expect(heartbeat).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(KAFKA_HEARTBEAT_INTERVAL_MS);
    expect(heartbeat).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(budgetMs - KAFKA_HEARTBEAT_INTERVAL_MS - 1);
    expect(outcome.settled).toBe(false);
    // 0 s, 3 s, …, 39 s.
    expect(heartbeat).toHaveBeenCalledTimes(14);

    await vi.advanceTimersByTimeAsync(1);
    expect(outcome.error).toBeInstanceOf(OperationTimeoutException);
    expect((outcome.error as Error).message).toBe(
      'fixture.user-registered.v1[0]@7 spent its in-process budget of 40000 ms (KafkaRetryInterceptor)',
    );

    // Nothing runs on: no further heartbeat, no further attempt, no timer left behind.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(heartbeat).toHaveBeenCalledTimes(14);
    expect(calls()).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts no further attempt once the budget ends during a delay', async () => {
    let attempts = 0;
    const next: CallHandler = {
      handle: () =>
        defer(
          after(500, () => {
            attempts += 1;
            return Promise.reject(new ServiceUnavailableException('cassandra down'));
          }),
        ),
    };
    const interceptor = new KafkaRetryInterceptor({
      budgetMs: 1_000,
      minDelayMs: 2_000,
      maxDelayMs: 2_000,
    });

    const outcome = watch(
      lastValueFrom(interceptor.intercept(executionContext('rpc', kafkaContext()), next)),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(attempts).toBe(1);
    expect(outcome.error).toBeInstanceOf(OperationTimeoutException);
    expect((outcome.error as Error).cause).toBeInstanceOf(ServiceUnavailableException);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(attempts).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds a handler without retries (attempts: 1) too', async () => {
    const { next } = never();
    const outcome = watch(
      lastValueFrom(
        new KafkaRetryInterceptor({ attempts: 1, budgetMs: 1_000 }).intercept(
          executionContext('rpc', kafkaContext()),
          next,
        ),
      ),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(outcome.error).toBeInstanceOf(OperationTimeoutException);
  });

  it("turns a spent budget into KafkaRetriableException with onBudgetExceeded: 'redeliver'", async () => {
    const { next } = never();
    const outcome = watch(
      lastValueFrom(
        new KafkaRetryInterceptor({ budgetMs: 1_000, onBudgetExceeded: 'redeliver' }).intercept(
          executionContext('rpc', kafkaContext()),
          next,
        ),
      ),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(outcome.error).toBeInstanceOf(KafkaRetriableException);
    expect((outcome.error as Error).cause).toBeInstanceOf(OperationTimeoutException);
  });

  it.each([
    ['rejects', () => Promise.reject(new Error('coordinator not available'))],
    [
      'throws',
      () => {
        throw new Error('not a promise');
      },
    ],
  ])(
    'a heartbeat that %s changes no outcome and is tried again 3 s later',
    async (_label, fail) => {
      const debug = vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
      const heartbeat = vi.fn<() => Promise<void>>(fail);
      const ok: CallHandler = { handle: () => defer(after(7_000, () => Promise.resolve('ok'))) };
      const outcome = watch(
        lastValueFrom(
          new KafkaRetryInterceptor().intercept(
            executionContext('rpc', kafkaContext(heartbeat)),
            ok,
          ),
        ),
      );
      await vi.advanceTimersByTimeAsync(7_000);
      expect(outcome).toEqual({ settled: true, value: 'ok' });
      expect(heartbeat).toHaveBeenCalledTimes(3);
      expect(debug).toHaveBeenCalledWith(
        expect.stringMatching(/^Heartbeat during fixture\.user-registered\.v1\[0\]@7 failed: /),
      );

      const failure = new DomainValidationException('nope');
      const failing: CallHandler = {
        handle: () => defer(after(7_000, () => Promise.reject(failure))),
      };
      const failed = watch(
        lastValueFrom(
          new KafkaRetryInterceptor().intercept(
            executionContext('rpc', kafkaContext(heartbeat)),
            failing,
          ),
        ),
      );
      await vi.advanceTimersByTimeAsync(7_000);
      expect(failed).toEqual({ settled: true, error: failure });
    },
  );

  it.each(['REBALANCE_IN_PROGRESS', 'NOT_COORDINATOR_FOR_GROUP', 'ILLEGAL_GENERATION'])(
    'stops heartbeating after a %s rejection (kafkajs rejoins after the message)',
    async (type) => {
      vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
      const heartbeat = vi.fn(() =>
        Promise.reject(Object.assign(new Error('The group is rebalancing'), { type })),
      );
      const ok: CallHandler = { handle: () => defer(after(10_000, () => Promise.resolve('ok'))) };
      const outcome = watch(
        lastValueFrom(
          new KafkaRetryInterceptor().intercept(
            executionContext('rpc', kafkaContext(heartbeat)),
            ok,
          ),
        ),
      );
      await vi.advanceTimersByTimeAsync(10_000);
      expect(outcome).toEqual({ settled: true, value: 'ok' });
      expect(heartbeat).toHaveBeenCalledTimes(1);
    },
  );

  it('skips heartbeats for a context without the function (a unit fake), and leaves no timer', async () => {
    const ok: CallHandler = { handle: () => defer(after(5_000, () => Promise.resolve('ok'))) };
    const outcome = watch(
      lastValueFrom(
        new KafkaRetryInterceptor().intercept(executionContext('rpc', kafkaContext(undefined)), ok),
      ),
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(outcome).toEqual({ settled: true, value: 'ok' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves a spent budget to the dead-letter filter by default', async () => {
    expect(DEFAULT_KAFKA_RETRY_OPTIONS.onBudgetExceeded).toBe('dead-letter');
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const send = vi.fn((_record: { messages: { headers: Record<string, unknown> }[] }) =>
      Promise.resolve([]),
    );
    const context = new KafkaContext([
      { key: 'k', value: {}, headers: {}, offset: '7' } as never,
      0,
      'fixture.user-registered.v1',
      {} as never,
      () => Promise.resolve(),
      { send } as never,
    ]);
    const rpc = executionContext('rpc', context) as ExecutionContext & ArgumentsHost;
    const { next } = never();
    const outcome = watch(
      lastValueFrom(
        new KafkaRetryInterceptor({ budgetMs: 1_000 })
          .intercept(rpc, next)
          .pipe(catchError((error: unknown) => new KafkaDeadLetterFilter().catch(error, rpc))),
      ),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(outcome).toEqual({ settled: true, value: null });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0].messages[0]?.headers['x-error-type']).toBe('TIMEOUT');
  });
});

describe('isRetriableKafkaHandlerError', () => {
  it('retries infrastructure and 5xx-class errors only', () => {
    expect(isRetriableKafkaHandlerError(new Error('socket hang up'))).toBe(true);
    expect(isRetriableKafkaHandlerError(new ServiceUnavailableException())).toBe(true);
    expect(isRetriableKafkaHandlerError(new InvalidEventException('bad'))).toBe(false);
  });
});

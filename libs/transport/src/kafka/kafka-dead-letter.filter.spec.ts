import { createRequire } from 'node:module';
import { type ArgumentsHost, Logger } from '@nestjs/common';
import { KafkaContext, KafkaRetriableException } from '@nestjs/microservices';
import { DomainValidationException } from '@platform/common';
import { register } from 'prom-client';
import { firstValueFrom, lastValueFrom, type Observable } from 'rxjs';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  buildDeadLetterRecord,
  errorTypeOf,
  KAFKA_DEAD_LETTER_SEND_TIMEOUT_MS,
  sendToDeadLetter,
} from './dead-letter.js';
import { InvalidEventException } from './kafka.errors.js';
import { KafkaDeadLetterFilter } from './kafka-dead-letter.filter.js';

type Send = (record: {
  topic: string;
  acks?: number;
  messages: { key: unknown; value: unknown; headers: Record<string, unknown> }[];
}) => Promise<unknown>;

/** A KafkaContext exactly as ServerKafka builds it: message already decoded by KafkaParser. */
function kafkaContext(send: Send): KafkaContext {
  const message = {
    key: 'user-1',
    value: { id: 'evt-1', payload: { userId: 'user-1' } },
    headers: { 'x-correlation-id': 'corr-1', 'x-event-type': 'fixture.user-registered.v1' },
    offset: '42',
    timestamp: '0',
    attributes: 0,
    size: 0,
  };
  const producer = { send };
  return new KafkaContext([
    message as never,
    3,
    'fixture.user-registered.v1',
    {} as never,
    () => Promise.resolve(),
    producer as never,
  ]);
}

/**
 * kafkajs' own consumer retrier (2.2.4, `retries: 0`), the one around `eachMessage`: the name of
 * the error it gives up with. `KafkaJSNumberOfRetriesExceeded` restarts the consumer (`onCrash`),
 * which redelivers the message; `KafkaJSNonRetriableError` (a `TypeError`, `RangeError`,
 * `ReferenceError` or `SyntaxError`, or `retriable: false`) stops it for good.
 */
async function kafkajsGivesUpWith(error: unknown): Promise<string> {
  const createRetry = createRequire(import.meta.url)('kafkajs/src/retry/index.js') as (options: {
    retries: number;
  }) => (fn: () => Promise<never>) => Promise<unknown>;
  const outcome = await createRetry({ retries: 0 })(() => Promise.reject(error as Error)).then(
    () => undefined,
    (crash: unknown) => crash,
  );
  return (outcome as Error).name;
}

const UNRECOVERABLE_IN_KAFKAJS = ['TypeError', 'RangeError', 'ReferenceError', 'SyntaxError'];

/** What the filter hands back to kafkajs when it cannot dead-letter: retriable, original as cause. */
function expectRedelivery(rethrown: unknown, original: unknown): void {
  expect(UNRECOVERABLE_IN_KAFKAJS).not.toContain((rethrown as Error).name);
  expect((rethrown as { retriable?: unknown }).retriable).not.toBe(false);
  expect((rethrown as Error).cause).toBe(original);
  expect(rethrown).toBeInstanceOf(KafkaRetriableException);
  expect((rethrown as Error).message).toBe((original as Error).message);
}

function host(type: string, context: unknown): ArgumentsHost {
  return {
    getType: () => type,
    switchToRpc: () => ({ getContext: () => context, getData: () => undefined }),
  } as unknown as ArgumentsHost;
}

describe('KafkaDeadLetterFilter', () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  it('publishes the original record + error headers to <topic>.dlq and EMITS so the offset commits', async () => {
    const send = vi.fn<Send>(() => Promise.resolve([]));
    const filter = new KafkaDeadLetterFilter();
    const error = new InvalidEventException('Invalid "fixture.user-registered.v1" event');

    const result$ = filter.catch(error, host('rpc', kafkaContext(send)));

    // Lazy: nothing is sent until Nest subscribes.
    expect(send).not.toHaveBeenCalled();
    await expect(lastValueFrom(result$)).resolves.toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
    const [record] = send.mock.calls[0] ?? [];
    expect(record?.topic).toBe('fixture.user-registered.v1.dlq');
    expect(record?.acks).toBe(-1);
    expect(record?.messages).toEqual([
      {
        key: 'user-1',
        value: JSON.stringify({ id: 'evt-1', payload: { userId: 'user-1' } }),
        headers: {
          'x-correlation-id': 'corr-1',
          'x-event-type': 'fixture.user-registered.v1',
          'x-original-topic': 'fixture.user-registered.v1',
          'x-original-partition': '3',
          'x-original-offset': '42',
          'x-error-type': 'INVALID_EVENT',
          'x-error-message': 'Invalid "fixture.user-registered.v1" event',
          'x-failed-at': expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) as string,
        },
      },
    ]);
  });

  it('rethrows KafkaRetriableException so kafkajs retries', async () => {
    const send = vi.fn<Send>(() => Promise.resolve([]));
    const error = new KafkaRetriableException('transient');
    const result$: Observable<null> = new KafkaDeadLetterFilter().catch(
      error,
      host('rpc', kafkaContext(send)),
    );
    await expect(firstValueFrom(result$)).rejects.toBe(error);
    expect(send).not.toHaveBeenCalled();
  });

  it('rethrows for non-Kafka contexts', async () => {
    const error = new Error('http');
    await expect(
      firstValueFrom(new KafkaDeadLetterFilter().catch(error, host('http', {}))),
    ).rejects.toBe(error);
    await expect(
      firstValueFrom(new KafkaDeadLetterFilter().catch(error, host('rpc', {}))),
    ).rejects.toBe(error);
  });

  it('hands kafkajs a KafkaRetriableException (cause: the original) when the dead-letter publish fails', async () => {
    const send = vi.fn<Send>(() => Promise.reject(new Error('broker down')));
    const error = new Error('handler failed');
    const rethrown = await lastValueFrom(
      new KafkaDeadLetterFilter().catch(error, host('rpc', kafkaContext(send))),
    ).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expectRedelivery(rethrown, error);
  });

  it.each([
    new TypeError("Cannot read properties of undefined (reading 'id')"),
    new RangeError('Invalid time value'),
    new ReferenceError('x is not defined'),
    new SyntaxError('Unexpected token'),
  ])(
    'a $name whose dead-letter send rejects at once: kafkajs retries, then restarts',
    async (error) => {
      expect(await kafkajsGivesUpWith(error)).toBe('KafkaJSNonRetriableError');
      const send = vi.fn<Send>(() => Promise.reject(new Error('broker down')));
      const rethrown = await lastValueFrom(
        new KafkaDeadLetterFilter().catch(error, host('rpc', kafkaContext(send))),
      ).then(
        () => undefined,
        (failure: unknown) => failure,
      );
      expectRedelivery(rethrown, error);
      expect(await kafkajsGivesUpWith(rethrown)).toBe('KafkaJSNumberOfRetriesExceeded');
    },
  );

  it('an error with retriable: false is wrapped too, so kafkajs retries it and then restarts', async () => {
    const error = Object.assign(new Error('Number of retries exceeded'), {
      name: 'KafkaJSNumberOfRetriesExceeded',
      retriable: false,
    });
    expect(await kafkajsGivesUpWith(error)).toBe('KafkaJSNonRetriableError');
    const send = vi.fn<Send>(() => Promise.reject(new Error('broker down')));
    const rethrown = await lastValueFrom(
      new KafkaDeadLetterFilter().catch(error, host('rpc', kafkaContext(send))),
    ).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expectRedelivery(rethrown, error);
    expect(await kafkajsGivesUpWith(rethrown)).toBe('KafkaJSNumberOfRetriesExceeded');
  });
});

describe('KafkaDeadLetterFilter: a slow dead-letter send', () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const redeliveries = async (): Promise<number> => {
    const metric = register.getSingleMetric('kafka_consumer_messages_total');
    const values = metric === undefined ? [] : (await metric.get()).values;
    return (
      values.find(
        ({ labels }) =>
          labels['topic'] === 'fixture.user-registered.v1' && labels['outcome'] === 'redelivery',
      )?.value ?? 0
    );
  };

  /** The outcome of `promise`, readable synchronously once the fake clock has moved. */
  function watch<T>(promise: Promise<T>): { settled: boolean; value?: T; error?: unknown } {
    const state: { settled: boolean; value?: T; error?: unknown } = { settled: false };
    promise.then(
      (value) => Object.assign(state, { settled: true, value }),
      (error: unknown) => Object.assign(state, { settled: true, error }),
    );
    return state;
  }

  it.each([
    new Error('handler failed'),
    new TypeError("Cannot read properties of undefined (reading 'id')"),
  ])(
    'waits 5 s for a send that never settles, then hands kafkajs a retriable error for a $name and counts redelivery',
    async (error) => {
      expect(KAFKA_DEAD_LETTER_SEND_TIMEOUT_MS).toBe(5_000);
      vi.useFakeTimers();
      const before = await redeliveries();
      const send = vi.fn<Send>(() => new Promise<never>(() => undefined));

      const outcome = watch(
        lastValueFrom(new KafkaDeadLetterFilter().catch(error, host('rpc', kafkaContext(send)))),
      );
      await vi.advanceTimersByTimeAsync(KAFKA_DEAD_LETTER_SEND_TIMEOUT_MS - 1);
      expect(outcome.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(outcome.settled).toBe(true);
      expectRedelivery(outcome.error, error);
      expect(await redeliveries()).toBe(before + 1);
      expect(send).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
      expect(await kafkajsGivesUpWith(outcome.error)).toBe('KafkaJSNumberOfRetriesExceeded');
    },
  );

  it('dead-letters a send that is slow but acknowledged within the deadline', async () => {
    vi.useFakeTimers();
    const send = vi.fn<Send>(() => new Promise((resolve) => setTimeout(() => resolve([]), 4_000)));
    const outcome = watch(
      lastValueFrom(
        new KafkaDeadLetterFilter().catch(new Error('poison'), host('rpc', kafkaContext(send))),
      ),
    );
    await vi.advanceTimersByTimeAsync(4_000);
    expect(outcome).toEqual({ settled: true, value: null });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('sendToDeadLetter takes its deadline as a parameter', async () => {
    const send = vi.fn<Send>(() => new Promise<never>(() => undefined));
    await expect(
      sendToDeadLetter(kafkaContext(send), new Error('x'), new Date(0), 10),
    ).rejects.toMatchObject({ code: 'TIMEOUT', details: { timeoutMs: 10 } });
  });
});

describe('buildDeadLetterRecord', () => {
  it('re-encodes values and headers and truncates long error messages', () => {
    const context = new KafkaContext([
      {
        key: null,
        value: 'plain text',
        headers: { json: { a: 1 }, binary: Buffer.from([0, 1]), none: null, list: ['x', 'y'] },
        offset: '7',
      } as never,
      0,
      'fixture.order-placed.v1',
      {} as never,
      () => Promise.resolve(),
      {} as never,
    ]);
    const record = buildDeadLetterRecord(context, new Error('x'.repeat(5_000)), new Date(0));
    expect(record.topic).toBe('fixture.order-placed.v1.dlq');
    expect(record.message.key).toBeNull();
    expect(record.message.value).toBe('plain text');
    expect(record.message.headers).toMatchObject({
      json: '{"a":1}',
      binary: Buffer.from([0, 1]),
      list: 'x',
      'x-failed-at': '1970-01-01T00:00:00.000Z',
    });
    expect(record.message.headers).not.toHaveProperty('none');
    expect(String(record.message.headers['x-error-message']).length).toBeLessThanOrEqual(1_024);
  });

  it('names errors by domain code, then class name', () => {
    expect(errorTypeOf(new DomainValidationException('bad'))).toBe('VALIDATION_FAILED');
    expect(errorTypeOf(new TypeError('x'))).toBe('TypeError');
    class CustomError extends Error {}
    expect(errorTypeOf(new CustomError('x'))).toBe('CustomError');
    expect(errorTypeOf('str')).toBe('string');
  });
});

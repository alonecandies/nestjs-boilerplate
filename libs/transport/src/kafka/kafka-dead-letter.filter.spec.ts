import { DomainValidationException } from '@app/common';
import { type ArgumentsHost, Logger } from '@nestjs/common';
import { KafkaContext, KafkaRetriableException } from '@nestjs/microservices';
import { firstValueFrom, lastValueFrom, type Observable } from 'rxjs';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { buildDeadLetterRecord, errorTypeOf } from './dead-letter.js';
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
    headers: { 'x-correlation-id': 'corr-1', 'x-event-type': 'identity.user-registered.v1' },
    offset: '42',
    timestamp: '0',
    attributes: 0,
    size: 0,
  };
  const producer = { send };
  return new KafkaContext([
    message as never,
    3,
    'identity.user-registered.v1',
    {} as never,
    () => Promise.resolve(),
    producer as never,
  ]);
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
    const error = new InvalidEventException('Invalid "identity.user-registered.v1" event');

    const result$ = filter.catch(error, host('rpc', kafkaContext(send)));

    // Lazy: nothing is sent until Nest subscribes.
    expect(send).not.toHaveBeenCalled();
    await expect(lastValueFrom(result$)).resolves.toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
    const [record] = send.mock.calls[0] ?? [];
    expect(record?.topic).toBe('identity.user-registered.v1.dlq');
    expect(record?.acks).toBe(-1);
    expect(record?.messages).toEqual([
      {
        key: 'user-1',
        value: JSON.stringify({ id: 'evt-1', payload: { userId: 'user-1' } }),
        headers: {
          'x-correlation-id': 'corr-1',
          'x-event-type': 'identity.user-registered.v1',
          'x-original-topic': 'identity.user-registered.v1',
          'x-original-partition': '3',
          'x-original-offset': '42',
          'x-error-type': 'INVALID_EVENT',
          'x-error-message': 'Invalid "identity.user-registered.v1" event',
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

  it('rethrows the original error when the dead-letter publish fails (redelivery, nothing lost)', async () => {
    const send = vi.fn<Send>(() => Promise.reject(new Error('broker down')));
    const error = new Error('handler failed');
    await expect(
      lastValueFrom(new KafkaDeadLetterFilter().catch(error, host('rpc', kafkaContext(send)))),
    ).rejects.toBe(error);
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
      'billing.payment-succeeded.v1',
      {} as never,
      () => Promise.resolve(),
      {} as never,
    ]);
    const record = buildDeadLetterRecord(context, new Error('x'.repeat(5_000)), new Date(0));
    expect(record.topic).toBe('billing.payment-succeeded.v1.dlq');
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

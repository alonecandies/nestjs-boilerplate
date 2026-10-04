import { DomainValidationException, ServiceUnavailableException } from '@app/common';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { KafkaContext, KafkaRetriableException } from '@nestjs/microservices';
import { defer, lastValueFrom } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { InvalidEventException } from './kafka.errors.js';
import {
  DEFAULT_KAFKA_RETRY_OPTIONS,
  isRetriableKafkaHandlerError,
  KafkaRetryInterceptor,
} from './kafka-retry.interceptor.js';

function kafkaContext(): KafkaContext {
  const message = { key: 'k', value: {}, headers: {}, offset: '7' };
  return new KafkaContext([
    message as never,
    0,
    'identity.user-registered.v1',
    {} as never,
    () => Promise.resolve(),
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

describe('KafkaRetryInterceptor', () => {
  it('retries a transient failure and succeeds without reaching the filter', async () => {
    const { next, attempts } = flakyHandler([
      new Error('connect ECONNREFUSED'),
      new Error('again'),
    ]);
    await expect(
      lastValueFrom(fast.intercept(executionContext('rpc', kafkaContext()), next)),
    ).resolves.toBe('ok');
    expect(attempts()).toBe(3);
  });

  it('gives up after the configured attempts and surfaces the last error (then dead-lettered)', async () => {
    const transient = new ServiceUnavailableException('cassandra down');
    const { next, attempts } = flakyHandler(Array.from({ length: 10 }, () => transient));
    await expect(
      lastValueFrom(fast.intercept(executionContext('rpc', kafkaContext()), next)),
    ).rejects.toBe(transient);
    expect(attempts()).toBe(DEFAULT_KAFKA_RETRY_OPTIONS.attempts);
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

describe('isRetriableKafkaHandlerError', () => {
  it('retries infrastructure and 5xx-class errors only', () => {
    expect(isRetriableKafkaHandlerError(new Error('socket hang up'))).toBe(true);
    expect(isRetriableKafkaHandlerError(new ServiceUnavailableException())).toBe(true);
    expect(isRetriableKafkaHandlerError(new InvalidEventException('bad'))).toBe(false);
  });
});

import type { CallHandler } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host.js';
import { delay, firstValueFrom, interval, lastValueFrom, of, take, toArray } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { Timeout } from '../decorators/timeout.decorator.js';
import { OperationTimeoutException } from '../errors/domain.exception.js';
import { TimeoutInterceptor } from './timeout.interceptor.js';

class DemoController {
  fast(): string {
    return 'fast';
  }
  @Timeout(5)
  slowWithOverride(): string {
    return 'slow';
  }
  @Timeout(0)
  unlimited(): string {
    return 'unlimited';
  }
}

function context(type: string, handler: () => string): ExecutionContextHost {
  const ctx = new ExecutionContextHost([{}, {}], DemoController, handler);
  ctx.setType(type);
  return ctx;
}

const respondAfter = (ms: number, value = 'done'): CallHandler => ({
  handle: () => of(value).pipe(delay(ms)),
});

describe('TimeoutInterceptor', () => {
  const reflector = new Reflector();
  const proto = DemoController.prototype;

  it('passes through responses produced within the default timeout', async () => {
    const interceptor = new TimeoutInterceptor(reflector, 200);
    await expect(
      lastValueFrom(interceptor.intercept(context('http', proto.fast), respondAfter(1))),
    ).resolves.toBe('done');
  });

  it('fails slow handlers with OperationTimeoutException (504)', async () => {
    const interceptor = new TimeoutInterceptor(reflector, 10);
    const result = lastValueFrom(
      interceptor.intercept(context('http', proto.fast), respondAfter(200)),
    );
    await expect(result).rejects.toBeInstanceOf(OperationTimeoutException);
    await expect(result).rejects.toMatchObject({ httpStatus: 504, details: { timeoutMs: 10 } });
  });

  it('applies @Timeout(ms) route overrides, and @Timeout(0) disables the timeout', async () => {
    const interceptor = new TimeoutInterceptor(reflector, 10_000);
    await expect(
      lastValueFrom(
        interceptor.intercept(context('graphql', proto.slowWithOverride), respondAfter(100)),
      ),
    ).rejects.toBeInstanceOf(OperationTimeoutException);

    const strict = new TimeoutInterceptor(reflector, 1);
    await expect(
      lastValueFrom(strict.intercept(context('http', proto.unlimited), respondAfter(20))),
    ).resolves.toBe('done');
  });

  it('only times the first emission (streams keep flowing)', async () => {
    const interceptor = new TimeoutInterceptor(reflector, 30);
    const stream: CallHandler = { handle: () => interval(15).pipe(take(4)) };
    await expect(
      lastValueFrom(interceptor.intercept(context('http', proto.fast), stream).pipe(toArray())),
    ).resolves.toEqual([0, 1, 2, 3]);
  });

  it.each(['rpc', 'ws'])('skips %s handlers entirely', async (type) => {
    const interceptor = new TimeoutInterceptor(reflector, 1);
    await expect(
      firstValueFrom(interceptor.intercept(context(type, proto.fast), respondAfter(20))),
    ).resolves.toBe('done');
  });

  it('defaults to 30s when no DEFAULT_TIMEOUT_MS is provided', () => {
    expect(new TimeoutInterceptor(reflector)).toMatchObject({ defaultTimeoutMs: 30_000 });
  });
});

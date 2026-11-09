import type { CallHandler, ExecutionContext } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import { lastValueFrom, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { markLockoutAttempt, takeLockoutAttempts } from './lockout.js';
import { LockoutResetInterceptor } from './lockout-reset.interceptor.js';

const httpContext = (req: object): ExecutionContext =>
  ({
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => req }),
  }) as unknown as ExecutionContext;
const gqlContext = (req: object): ExecutionContext =>
  ({
    getType: () => 'graphql',
    getArgByIndex: (i: number) => (i === 2 ? { req } : {}),
  }) as unknown as ExecutionContext;

/** A storage double; `extra` adds the optional `reset()` the real Redis storage has. */
const storageOf = (extra: object = {}): ThrottlerStorage => ({ increment: vi.fn(), ...extra });

describe('LockoutResetInterceptor', () => {
  it('resets the lockout counters of a successful credential attempt (http and graphql)', async () => {
    for (const make of [httpContext, gqlContext]) {
      const reset = vi.fn(async () => undefined);
      const interceptor = new LockoutResetInterceptor(storageOf({ reset }));
      const req = {};
      markLockoutAttempt(req, 'k1');
      const next: CallHandler = { handle: () => of('tokens') };
      await expect(lastValueFrom(interceptor.intercept(make(req), next))).resolves.toBe('tokens');
      expect(reset).toHaveBeenCalledWith('k1', 'lockout');
      expect(takeLockoutAttempts(req)).toBeUndefined();
    }
  });

  it('keeps the counter when the handler fails', async () => {
    const reset = vi.fn(async () => undefined);
    const interceptor = new LockoutResetInterceptor(storageOf({ reset }));
    const req = {};
    markLockoutAttempt(req, 'k1');
    const next: CallHandler = { handle: () => throwError(() => new Error('INVALID_CREDENTIALS')) };
    await expect(lastValueFrom(interceptor.intercept(httpContext(req), next))).rejects.toThrow();
    expect(reset).not.toHaveBeenCalled();
  });

  it('is a no-op on requests without credential attempts or storages without reset()', async () => {
    const interceptor = new LockoutResetInterceptor(storageOf());
    const req = {};
    markLockoutAttempt(req, 'k1');
    await expect(
      lastValueFrom(interceptor.intercept(httpContext(req), { handle: () => of(1) })),
    ).resolves.toBe(1);
    await expect(
      lastValueFrom(interceptor.intercept(httpContext({}), { handle: () => of(2) })),
    ).resolves.toBe(2);
  });

  it('never fails a successful login because the reset failed', async () => {
    const interceptor = new LockoutResetInterceptor(
      storageOf({
        reset: vi.fn(async () => {
          throw new Error('redis down');
        }),
      }),
    );
    const req = {};
    markLockoutAttempt(req, 'k1');
    await expect(
      lastValueFrom(interceptor.intercept(httpContext(req), { handle: () => of('ok') })),
    ).resolves.toBe('ok');
  });
});

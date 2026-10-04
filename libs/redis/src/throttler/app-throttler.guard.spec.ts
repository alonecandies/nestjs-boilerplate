import { throttleConfig } from '@app/config';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  ThrottlerException,
  type ThrottlerModuleOptions,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import { describe, expect, it, vi } from 'vitest';
import { AppThrottlerGuard } from './app-throttler.guard.js';
import { AuthThrottle } from './auth-throttle.decorator.js';
import type { ThrottlerStorageRecord } from './redis-throttler.storage.js';
import { DEFAULT_THROTTLE_EXEMPT_PATHS } from './throttle.constants.js';
import { createThrottleSkipIf, isThrottleExemptPath } from './throttle-exempt.util.js';

class Controller {
  list(): void {
    // route handler stub
  }

  @AuthThrottle()
  login(): void {
    // route handler stub
  }
}

type Transport = 'http' | 'graphql' | 'ws' | 'rpc';

function context(
  type: Transport,
  req: Record<string, unknown>,
  handler: () => void = Controller.prototype.list,
  res: Record<string, unknown> = { header: vi.fn() },
): ExecutionContext {
  const gqlArgs = [{}, {}, { req, reply: res }, {}];
  return {
    getType: () => type,
    getHandler: () => handler,
    getClass: () => Controller,
    getArgByIndex: (index: number) => gqlArgs[index],
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
      getNext: () => undefined,
    }),
  } as unknown as ExecutionContext;
}

const record = (overrides: Partial<ThrottlerStorageRecord> = {}): ThrottlerStorageRecord => ({
  totalHits: 1,
  timeToExpire: 60,
  isBlocked: false,
  timeToBlockExpire: 0,
  ...overrides,
});

async function createGuard(options: Partial<Exclude<ThrottlerModuleOptions, unknown[]>> = {}) {
  const increment = vi.fn<ThrottlerStorage['increment']>(async () => record());
  const guard = new AppThrottlerGuard(
    { throttlers: [{ name: 'default', ttl: 60_000, limit: 100 }], ...options },
    { increment },
    new Reflector(),
  );
  Reflect.set(
    guard,
    'limits',
    throttleConfig.parse({ THROTTLE_AUTH_LIMIT: '7', THROTTLE_AUTH_TTL_MS: '30000' }),
  );
  await guard.onModuleInit();
  return { guard, increment };
}

describe('AppThrottlerGuard', () => {
  it('tracks authenticated users by id and anonymous clients by (normalised) IP', async () => {
    const { guard, increment } = await createGuard();
    await guard.canActivate(context('http', { headers: {}, user: { id: 'u-1' }, ip: '1.2.3.4' }));
    await guard.canActivate(context('http', { headers: {}, ip: '2001:db8:abcd:12:1:2:3:4' }));
    await guard.canActivate(context('http', { headers: {} }));

    const trackers = increment.mock.calls.map(([key]) => key);
    expect(new Set(trackers).size).toBe(3); // keys are sha256(route + tracker)
    const getTracker = (req: Record<string, unknown>) =>
      Reflect.apply(Reflect.get(guard, 'getTracker'), guard, [req]);
    await expect(getTracker({ user: { id: 'u-1' }, ip: '1.2.3.4' })).resolves.toBe('user:u-1');
    await expect(getTracker({ user: { id: '' }, ip: '1.2.3.4' })).resolves.toBe('ip:1.2.3.4');
    await expect(getTracker({ ip: '2001:db8:abcd:12:1:2:3:4' })).resolves.toBe(
      'ip:2001:db8:abcd:12::/64',
    );
    await expect(getTracker({})).resolves.toBe('ip:unknown');
  });

  it('skips ws and rpc handlers entirely', async () => {
    const { guard, increment } = await createGuard();
    await expect(guard.canActivate(context('ws', {}))).resolves.toBe(true);
    await expect(guard.canActivate(context('rpc', {}))).resolves.toBe(true);
    expect(increment).not.toHaveBeenCalled();
  });

  it('throttles GraphQL through the { req, reply } context, and tolerates a missing reply', async () => {
    const { guard, increment } = await createGuard();
    const reply = { header: vi.fn() };
    await guard.canActivate(context('graphql', { headers: {}, ip: '9.9.9.9' }, undefined, reply));
    expect(increment).toHaveBeenCalledOnce();
    expect(reply.header).toHaveBeenCalledWith('X-RateLimit-Limit', 100);

    const subscription = {
      getType: () => 'graphql',
      getHandler: () => Controller.prototype.list,
      getClass: () => Controller,
      getArgByIndex: () => undefined,
    } as unknown as ExecutionContext;
    await expect(guard.canActivate(subscription)).resolves.toBe(true);
  });

  it('applies the THROTTLE_AUTH_* window to @AuthThrottle() handlers', async () => {
    const { guard, increment } = await createGuard();
    await guard.canActivate(
      context('http', { headers: {}, ip: '1.1.1.1' }, Controller.prototype.login),
    );
    expect(increment).toHaveBeenCalledWith(expect.any(String), 30_000, 7, 30_000, 'default');
    await guard.canActivate(context('http', { headers: {}, ip: '1.1.1.1' }));
    expect(increment).toHaveBeenLastCalledWith(expect.any(String), 60_000, 100, 60_000, 'default');
  });

  it('rejects with 429 (ThrottlerException) + Retry-After when blocked', async () => {
    const { guard, increment } = await createGuard();
    increment.mockResolvedValue(record({ totalHits: 101, isBlocked: true, timeToBlockExpire: 42 }));
    const res = { header: vi.fn() };
    await expect(
      guard.canActivate(context('http', { headers: {}, ip: '1.1.1.1' }, undefined, res)),
    ).rejects.toBeInstanceOf(ThrottlerException);
    expect(res.header).toHaveBeenCalledWith('Retry-After', 42);
  });

  it('honours module-level skipIf for exempt ops paths', async () => {
    const { guard, increment } = await createGuard({
      skipIf: createThrottleSkipIf(DEFAULT_THROTTLE_EXEMPT_PATHS),
    });
    await guard.canActivate(context('http', { headers: {}, url: '/health/ready?full=1' }));
    await guard.canActivate(context('http', { headers: {}, url: '/metrics' }));
    expect(increment).not.toHaveBeenCalled();
    await guard.canActivate(context('http', { headers: {}, url: '/v1/users' }));
    expect(increment).toHaveBeenCalledOnce();
  });
});

describe('throttle exemptions', () => {
  it('matches prefixes on a "/" boundary', () => {
    const exempt = ['/health', '/metrics'];
    expect(isThrottleExemptPath('/health', exempt)).toBe(true);
    expect(isThrottleExemptPath('/health/live', exempt)).toBe(true);
    expect(isThrottleExemptPath('/healthz', exempt)).toBe(false);
    expect(isThrottleExemptPath('/v1/metrics', exempt)).toBe(false);
  });

  it('only applies to HTTP and is a no-op without exempt paths', () => {
    const skipIf = createThrottleSkipIf(['/health']);
    expect(skipIf(context('graphql', { url: '/health' }))).toBe(false);
    expect(skipIf(context('http', { url: '/health' }))).toBe(true);
    expect(createThrottleSkipIf([])(context('http', { url: '/health' }))).toBe(false);
  });
});

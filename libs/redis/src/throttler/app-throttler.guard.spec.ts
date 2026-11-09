import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  SkipThrottle,
  ThrottlerException,
  type ThrottlerModuleOptions,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import { throttleConfig } from '@platform/config';
import { describe, expect, it, vi } from 'vitest';
import { AppThrottlerGuard } from './app-throttler.guard.js';
import { AuthThrottle } from './auth-throttle.decorator.js';
import { RateLimit, SkipRateLimit } from './rate-limit.decorator.js';
import { rateLimitKey } from './rate-limit-key.util.js';
import { RateLimitPolicyRegistry } from './rate-limit-policy.js';
import type { ThrottlerStorageRecord } from './redis-throttler.storage.js';
import {
  DEFAULT_THROTTLE_EXEMPT_PATHS,
  RATE_LIMIT_THROTTLERS,
  THROTTLER,
} from './throttle.constants.js';
import { createThrottleSkipIf, isThrottleExemptPath } from './throttle-exempt.util.js';

class Controller {
  list(): void {
    // route handler stub
  }
  other(): void {
    // route handler stub
  }
  @AuthThrottle() login(): void {
    // route handler stub
  }
  @AuthThrottle() register(): void {
    // route handler stub
  }
  @RateLimit('files.upload') upload(): void {
    // route handler stub
  }
  @RateLimit('files.upload') uploadAgain(): void {
    // route handler stub
  }
  @RateLimit('files.search') search(): void {
    // route handler stub
  }
  @SkipRateLimit() webhook(): void {
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
    getArgs: () => gqlArgs,
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
    {
      throttlers: [
        { name: THROTTLER.USER, ttl: 60_000, limit: 100 },
        { name: THROTTLER.ROUTE, ttl: 60_000, limit: 100 },
      ],
      ...options,
    },
    { increment },
    new Reflector(),
  );
  const registry = new RateLimitPolicyRegistry();
  registry.register([
    { name: 'files.upload', key: 'user', limit: 3, ttlMs: 10_000 },
    { name: 'files.search', key: 'ip', limit: 9, ttlMs: 5_000, blockMs: 0 },
  ]);
  Reflect.set(guard, 'policies', registry);
  Reflect.set(
    guard,
    'limits',
    throttleConfig.parse({ THROTTLE_AUTH_LIMIT: '7', THROTTLE_AUTH_TTL_MS: '30000' }),
  );
  await guard.onModuleInit();
  return { guard, increment };
}

const http = (handler: () => void, req: Record<string, unknown> = { headers: {}, ip: '1.2.3.4' }) =>
  context('http', req, handler);

describe('AppThrottlerGuard', () => {
  it('charges one user budget across every route (scope "global")', async () => {
    const { guard, increment } = await createGuard();
    const req = { headers: {}, user: { id: 'u-1' }, ip: '1.2.3.4' };
    await guard.canActivate(http(Controller.prototype.list, req));
    await guard.canActivate(http(Controller.prototype.other, req));
    const userCalls = increment.mock.calls.filter(([, , , , name]) => name === THROTTLER.USER);
    expect(userCalls).toHaveLength(2);
    expect(userCalls[0]?.[0]).toBe(rateLimitKey('user', 'global', 'user:u-1'));
    expect(userCalls[1]?.[0]).toBe(userCalls[0]?.[0]);
  });

  it('falls back to the (normalised) client IP for anonymous requests', async () => {
    const { guard, increment } = await createGuard();
    await guard.canActivate(
      http(Controller.prototype.list, { headers: {}, ip: '2001:db8:abcd:12:1:2:3:4' }),
    );
    await guard.canActivate(http(Controller.prototype.list, { headers: {} }));
    expect(increment.mock.calls.map(([key]) => key)).toEqual([
      rateLimitKey('user', 'global', 'ip:2001:db8:abcd:12::/64'),
      rateLimitKey('user', 'global', 'ip:unknown'),
    ]);
  });

  it('charges a @RateLimit policy bucket shared by every route naming it, with the policy limits', async () => {
    const { guard, increment } = await createGuard();
    const req = { headers: {}, user: { id: 'u-1' }, ip: '1.2.3.4' };
    await guard.canActivate(http(Controller.prototype.upload, req));
    await guard.canActivate(http(Controller.prototype.uploadAgain, req));
    const routeCalls = increment.mock.calls.filter(([, , , , name]) => name === THROTTLER.ROUTE);
    expect(routeCalls).toEqual([
      [rateLimitKey('route', 'files.upload', 'user:u-1'), 10_000, 3, 10_000, 'route'],
      [rateLimitKey('route', 'files.upload', 'user:u-1'), 10_000, 3, 10_000, 'route'],
    ]);
  });

  it('keys an "ip" policy by IP even for authenticated users and honours blockMs', async () => {
    const { guard, increment } = await createGuard();
    await guard.canActivate(
      http(Controller.prototype.search, { headers: {}, user: { id: 'u-1' }, ip: '9.9.9.9' }),
    );
    expect(increment).toHaveBeenCalledWith(
      rateLimitKey('route', 'files.search', 'ip:9.9.9.9'),
      5_000,
      9,
      0,
      'route',
    );
  });

  it('does not charge the route throttler on routes without a policy', async () => {
    const { guard, increment } = await createGuard();
    await guard.canActivate(http(Controller.prototype.list));
    expect(increment.mock.calls.map(([, , , , name]) => name)).toEqual([THROTTLER.USER]);
  });

  it('shares one "auth" bucket across every @AuthThrottle route (F17)', async () => {
    const { guard, increment } = await createGuard();
    await guard.canActivate(http(Controller.prototype.login));
    await guard.canActivate(http(Controller.prototype.register));
    expect(increment.mock.calls).toEqual([
      [rateLimitKey('user', 'auth', 'ip:1.2.3.4'), 30_000, 7, 30_000, 'user'],
      [rateLimitKey('user', 'auth', 'ip:1.2.3.4'), 30_000, 7, 30_000, 'user'],
    ]);
  });

  it('@SkipRateLimit() skips every named throttler', async () => {
    const { guard, increment } = await createGuard();
    await expect(guard.canActivate(http(Controller.prototype.webhook))).resolves.toBe(true);
    expect(increment).not.toHaveBeenCalled();
    for (const name of RATE_LIMIT_THROTTLERS) {
      expect(Reflect.getMetadata(`THROTTLER:SKIP${name}`, Controller.prototype.webhook)).toBe(true);
    }
  });

  it('throttles graphql through the { req, reply } context and skips ws and rpc', async () => {
    const { guard, increment } = await createGuard();
    await guard.canActivate(context('graphql', { headers: {}, user: { id: 'u-2' } }));
    expect(increment.mock.calls[0]?.[0]).toBe(rateLimitKey('user', 'global', 'user:u-2'));
    increment.mockClear();
    await expect(guard.canActivate(context('ws', {}))).resolves.toBe(true);
    await expect(guard.canActivate(context('rpc', {}))).resolves.toBe(true);
    expect(increment).not.toHaveBeenCalled();
  });

  it('rejects a blocked bucket with ThrottlerException and Retry-After', async () => {
    const { guard, increment } = await createGuard();
    increment.mockResolvedValue(record({ isBlocked: true, totalHits: 101, timeToBlockExpire: 42 }));
    const res = { header: vi.fn() };
    await expect(
      guard.canActivate(
        context('http', { headers: {}, ip: '1.2.3.4' }, Controller.prototype.list, res),
      ),
    ).rejects.toBeInstanceOf(ThrottlerException);
    expect(res.header).toHaveBeenCalledWith('Retry-After', 42);
  });

  it('honours ignoreUserAgents', async () => {
    const { guard, increment } = await createGuard({ ignoreUserAgents: [/kube-probe/i] });
    await guard.canActivate(
      http(Controller.prototype.list, {
        headers: { 'user-agent': 'kube-probe/1.30' },
        ip: '1.2.3.4',
      }),
    );
    expect(increment).not.toHaveBeenCalled();
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

  it('lets graphql-ws subscriptions (no context) through', async () => {
    const { guard } = await createGuard();
    const subscription = {
      getType: () => 'graphql',
      getHandler: () => Controller.prototype.list,
      getClass: () => Controller,
      getArgByIndex: () => undefined,
    } as unknown as ExecutionContext;
    await expect(guard.canActivate(subscription)).resolves.toBe(true);
  });

  it('a raw @SkipThrottle() only skips the throttler named default (use SkipRateLimit)', () => {
    class Legacy {
      @SkipThrottle() handler(): void {
        // route handler stub
      }
    }
    expect(Reflect.getMetadata('THROTTLER:SKIPuser', Legacy.prototype.handler)).toBeUndefined();
  });
});

describe('throttle exemptions', () => {
  it('matches ops paths on a / boundary only', () => {
    expect(isThrottleExemptPath('/health/ready', DEFAULT_THROTTLE_EXEMPT_PATHS)).toBe(true);
    expect(isThrottleExemptPath('/healthz', DEFAULT_THROTTLE_EXEMPT_PATHS)).toBe(false);
    const skipIf = createThrottleSkipIf(['/health']);
    const ctx = context('http', { url: '/health/live', headers: {} });
    expect(skipIf(ctx)).toBe(true);
  });

  it('only applies to HTTP and is a no-op without exempt paths', () => {
    const skipIf = createThrottleSkipIf(['/health']);
    expect(skipIf(context('graphql', { url: '/health' }))).toBe(false);
    expect(skipIf(context('http', { url: '/health' }))).toBe(true);
    expect(createThrottleSkipIf([])(context('http', { url: '/health' }))).toBe(false);
  });
});

import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  SkipThrottle,
  ThrottlerException,
  type ThrottlerModuleOptions,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import { describe, expect, it, vi } from 'vitest';
import { AppThrottlerGuard } from './app-throttler.guard.js';
import { credentialHash } from './credential-tracker.util.js';
import { takeLockoutAttempts } from './lockout.js';
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
  @RateLimit('id.credentials') login(): void {
    // route handler stub
  }
  @RateLimit('id.credentials') gqlLogin(): void {
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
        { name: THROTTLER.TENANT, ttl: 60_000, limit: 3_000 },
        { name: THROTTLER.ROUTE, ttl: 60_000, limit: 100 },
        { name: THROTTLER.AUTH, ttl: 60_000, limit: 100 },
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
    {
      name: 'id.credentials',
      key: 'credentials',
      limit: 4,
      ttlMs: 30_000,
      lockout: { threshold: 3, durationMs: 900_000 },
    },
  ]);
  Reflect.set(guard, 'policies', registry);
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

  it('charges one tenant budget shared by every member of the tenant', async () => {
    const { guard, increment } = await createGuard();
    await guard.canActivate(
      http(Controller.prototype.list, { headers: {}, user: { id: 'u-1', tenantId: 't-1' } }),
    );
    await guard.canActivate(
      http(Controller.prototype.other, { headers: {}, user: { id: 'u-2', tenantId: 't-1' } }),
    );
    await guard.canActivate(
      http(Controller.prototype.list, { headers: {}, user: { id: 'u-3', tenantId: 't-2' } }),
    );
    const tenantKeys = increment.mock.calls.filter(([, , , , n]) => n === 'tenant').map(([k]) => k);
    expect(tenantKeys).toEqual([
      rateLimitKey('tenant', 'global', 'tenant:t-1'),
      rateLimitKey('tenant', 'global', 'tenant:t-1'),
      rateLimitKey('tenant', 'global', 'tenant:t-2'),
    ]);
  });

  it('does not charge a tenant for anonymous requests', async () => {
    const { guard, increment } = await createGuard();
    await guard.canActivate(http(Controller.prototype.list));
    expect(increment.mock.calls.map(([, , , , n]) => n)).not.toContain('tenant');
  });

  it('lists the tenant budget in the IETF headers', async () => {
    const { guard } = await createGuard();
    const res = { header: vi.fn() };
    await guard.canActivate(
      context(
        'http',
        { headers: {}, user: { id: 'u-1', tenantId: 't-1' } },
        Controller.prototype.list,
        res,
      ),
    );
    expect(res.header).toHaveBeenCalledWith(
      'RateLimit-Policy',
      '"user";q=100;w=60, "tenant";q=3000;w=60',
    );
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

  it('sets RateLimit-Policy and RateLimit for every charged budget, and on 429 too', async () => {
    const { guard, increment } = await createGuard();
    increment.mockImplementation(async (_k, _t, _l, _b, name) =>
      name === 'route'
        ? record({ totalHits: 3, timeToExpire: 8 })
        : record({ totalHits: 10, timeToExpire: 50 }),
    );
    const res = { header: vi.fn() };
    await guard.canActivate(
      context('http', { headers: {}, user: { id: 'u-1' } }, Controller.prototype.upload, res),
    );
    expect(res.header).toHaveBeenLastCalledWith(
      'RateLimit',
      '"user";r=90;t=50, "route:files.upload";r=0;t=8',
    );
    expect(res.header).toHaveBeenCalledWith(
      'RateLimit-Policy',
      '"user";q=100;w=60, "route:files.upload";q=3;w=10',
    );

    const blockedRes = { header: vi.fn() };
    increment.mockResolvedValue(record({ isBlocked: true, totalHits: 101, timeToBlockExpire: 30 }));
    await expect(
      guard.canActivate(
        context('http', { headers: {}, ip: '1.2.3.4' }, Controller.prototype.list, blockedRes),
      ),
    ).rejects.toBeInstanceOf(ThrottlerException);
    expect(blockedRes.header).toHaveBeenCalledWith('RateLimit', '"user";r=0;t=30');
    expect(blockedRes.header).toHaveBeenCalledWith('Retry-After', 30);
  });

  it('never advertises the lockout bucket', async () => {
    const { guard } = await createGuard();
    const res = { header: vi.fn() };
    await guard.canActivate(
      context(
        'http',
        { headers: {}, ip: '1.2.3.4', body: { email: 'a@x.io' } },
        Controller.prototype.login,
        res,
      ),
    );
    const values = res.header.mock.calls.map(([, value]) => String(value)).join(' ');
    expect(values).toContain('"auth:id.credentials"');
    expect(values).not.toContain('lockout');
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

describe('auth throttler (credentials policies)', () => {
  const credKey = (email: string, ip = 'ip:1.2.3.4') =>
    rateLimitKey('auth', 'id.credentials', `cred:${credentialHash(email)}|${ip}`);

  it('keys REST and GraphQL attempts for one account and IP into one bucket (F17)', async () => {
    const { guard, increment } = await createGuard();
    await guard.canActivate(
      http(Controller.prototype.login, { headers: {}, ip: '1.2.3.4', body: { email: 'A@x.io ' } }),
    );
    const gql = context('graphql', { headers: {}, ip: '1.2.3.4' }, Controller.prototype.gqlLogin);
    Reflect.set(gql, 'getArgByIndex', (i: number) =>
      i === 1
        ? { input: { email: 'a@x.io' } }
        : i === 2
          ? { req: { headers: {}, ip: '1.2.3.4' }, reply: { header: vi.fn() } }
          : {},
    );
    await guard.canActivate(gql);
    const authCalls = increment.mock.calls.filter(([, , , , name]) => name === THROTTLER.AUTH);
    expect(authCalls).toEqual([
      [credKey('a@x.io'), 30_000, 4, 30_000, 'auth'],
      [credKey('a@x.io'), 30_000, 4, 30_000, 'auth'],
    ]);
  });

  it('separates accounts and IPs, and shares "none" for a missing email', async () => {
    const { guard, increment } = await createGuard();
    await guard.canActivate(
      http(Controller.prototype.login, { headers: {}, ip: '1.2.3.4', body: { email: 'b@x.io' } }),
    );
    await guard.canActivate(
      http(Controller.prototype.login, { headers: {}, ip: '5.6.7.8', body: { email: 'b@x.io' } }),
    );
    await guard.canActivate(
      http(Controller.prototype.login, { headers: {}, ip: '1.2.3.4', body: { email: ['a', 'b'] } }),
    );
    const keys = increment.mock.calls.filter(([, , , , n]) => n === THROTTLER.AUTH).map(([k]) => k);
    expect(keys).toEqual([
      credKey('b@x.io'),
      credKey('b@x.io', 'ip:5.6.7.8'),
      rateLimitKey('auth', 'id.credentials', 'cred:none|ip:1.2.3.4'),
    ]);
  });

  it('counts a lockout attempt per account (any IP) and marks it for reset on success', async () => {
    const { guard, increment } = await createGuard();
    const req = { headers: {}, ip: '1.2.3.4', body: { email: 'c@x.io' } };
    await guard.canActivate(http(Controller.prototype.login, req));
    const lockoutKey = rateLimitKey(
      'lockout',
      'id.credentials',
      `acct:${credentialHash('c@x.io')}`,
    );
    expect(increment).toHaveBeenCalledWith(lockoutKey, 900_000, 3, 900_000, 'lockout');
    expect(takeLockoutAttempts(req)).toEqual([lockoutKey]);
  });

  it('a locked account answers exactly like a rate limit (429 + Retry-After), existing or not', async () => {
    const { guard, increment } = await createGuard();
    increment.mockImplementation(async (_key, _ttl, _limit, _block, name) =>
      name === 'lockout'
        ? record({ isBlocked: true, totalHits: 4, timeToBlockExpire: 900 })
        : record(),
    );
    for (const email of ['exists@x.io', 'ghost@x.io']) {
      const res = { header: vi.fn() };
      await expect(
        guard.canActivate(
          context(
            'http',
            { headers: {}, ip: '1.2.3.4', body: { email } },
            Controller.prototype.login,
            res,
          ),
        ),
      ).rejects.toBeInstanceOf(ThrottlerException);
      expect(res.header).toHaveBeenCalledWith('Retry-After', 900);
    }
  });

  it('does not lock out requests without a credential and ignores non-credential routes', async () => {
    const { guard, increment } = await createGuard();
    await guard.canActivate(
      http(Controller.prototype.login, { headers: {}, ip: '1.2.3.4', body: {} }),
    );
    await guard.canActivate(http(Controller.prototype.list));
    expect(increment.mock.calls.map(([, , , , n]) => n)).not.toContain('lockout');
    expect(increment.mock.calls.filter(([, , , , n]) => n === 'auth')).toHaveLength(1);
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

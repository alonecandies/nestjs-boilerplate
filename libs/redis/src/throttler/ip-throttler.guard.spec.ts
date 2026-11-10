import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ThrottlerStorage } from '@nestjs/throttler';
import { describe, expect, it, vi } from 'vitest';
import { IpThrottlerGuard } from './ip-throttler.guard.js';
import { rateLimitKey } from './rate-limit-key.util.js';
import { RateLimitPolicyRegistry } from './rate-limit-policy.js';
import { THROTTLER } from './throttle.constants.js';

class Controller {
  handle(): void {
    // route handler stub
  }
}

const context = (type: string, req: Record<string, unknown>): ExecutionContext =>
  ({
    getType: () => type,
    getHandler: () => Controller.prototype.handle,
    getClass: () => Controller,
    getArgByIndex: (i: number) => (i === 2 ? { req, reply: { header: vi.fn() } } : {}),
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({ header: vi.fn() }) }),
  }) as unknown as ExecutionContext;

async function createGuard() {
  const increment = vi.fn<ThrottlerStorage['increment']>(async () => ({
    totalHits: 1,
    timeToExpire: 60,
    isBlocked: false,
    timeToBlockExpire: 0,
  }));
  const guard = new IpThrottlerGuard(
    {
      throttlers: [
        { name: THROTTLER.IP, ttl: 60_000, limit: 600 },
        { name: THROTTLER.USER, ttl: 60_000, limit: 100 },
        { name: THROTTLER.ROUTE, ttl: 60_000, limit: 100 },
        { name: THROTTLER.AUTH, ttl: 60_000, limit: 100 },
      ],
    },
    { increment },
    new Reflector(),
  );
  Reflect.set(guard, 'policies', new RateLimitPolicyRegistry());
  await guard.onModuleInit();
  return { guard, increment };
}

describe('IpThrottlerGuard', () => {
  it('charges only the ip budget, keyed by client IP even when a user is present', async () => {
    const { guard, increment } = await createGuard();
    await guard.canActivate(context('http', { headers: {}, ip: '1.2.3.4', user: { id: 'u-1' } }));
    expect(increment.mock.calls).toEqual([
      [rateLimitKey('ip', 'global', 'ip:1.2.3.4'), 60_000, 600, 60_000, 'ip'],
    ]);
  });

  it('runs for graphql and skips ws and rpc', async () => {
    const { guard, increment } = await createGuard();
    await guard.canActivate(context('graphql', { headers: {}, ip: '1.2.3.4' }));
    await guard.canActivate(context('ws', {}));
    await guard.canActivate(context('rpc', {}));
    expect(increment).toHaveBeenCalledTimes(1);
  });
});

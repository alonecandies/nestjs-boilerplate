import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ThrottlerException, type ThrottlerStorage } from '@nestjs/throttler';
import { describe, expect, it, vi } from 'vitest';
import { RateLimit } from './rate-limit.decorator.js';
import { rateLimitKey } from './rate-limit-key.util.js';
import { RateLimitPolicyRegistry } from './rate-limit-policy.js';
import type { ThrottlerStorageRecord } from './redis-throttler.storage.js';
import { THROTTLER } from './throttle.constants.js';
import { throttleTracker } from './throttle-tracker.util.js';
import { WsThrottlerGuard } from './ws-throttler.guard.js';

class Gateway {
  onMessage(): void {
    // route handler stub
  }
  @RateLimit('chat.send') send(): void {
    // route handler stub
  }
}

const record = (overrides: Partial<ThrottlerStorageRecord> = {}): ThrottlerStorageRecord => ({
  totalHits: 1,
  timeToExpire: 10,
  isBlocked: false,
  timeToBlockExpire: 0,
  ...overrides,
});

function wsContext(
  socket: Record<string, unknown>,
  handler = Gateway.prototype.onMessage,
  type = 'ws',
): ExecutionContext {
  return {
    getType: () => type,
    getHandler: () => handler,
    getClass: () => Gateway,
    switchToWs: () => ({ getClient: () => socket, getData: () => ({}) }),
  } as unknown as ExecutionContext;
}

async function createGuard() {
  const increment = vi.fn<ThrottlerStorage['increment']>(async () => record());
  const guard = new WsThrottlerGuard(
    {
      throttlers: [
        { name: THROTTLER.USER, ttl: 60_000, limit: 100 },
        { name: THROTTLER.ROUTE, ttl: 60_000, limit: 100 },
      ],
    },
    { increment },
    new Reflector(),
  );
  const registry = new RateLimitPolicyRegistry();
  registry.register([{ name: 'chat.send', key: 'user', limit: 5, ttlMs: 10_000 }]);
  Reflect.set(guard, 'policies', registry);
  await guard.onModuleInit();
  return { guard, increment };
}

describe('WsThrottlerGuard', () => {
  it('charges the socket user to the global user budget and the message policy', async () => {
    const { guard, increment } = await createGuard();
    await guard.canActivate(
      wsContext(
        { data: { user: { id: 'u-1' } }, handshake: { address: '1.2.3.4' } },
        Gateway.prototype.send,
      ),
    );
    expect(increment.mock.calls).toEqual(
      expect.arrayContaining([
        [rateLimitKey('user', 'global', 'user:u-1'), 60_000, 100, 60_000, 'user'],
        [rateLimitKey('route', 'chat.send', 'user:u-1'), 10_000, 5, 10_000, 'route'],
      ]),
    );
  });

  it('falls back to the handshake address', async () => {
    const { guard, increment } = await createGuard();
    await guard.canActivate(wsContext({ data: {}, handshake: { address: '5.6.7.8' } }));
    expect(increment.mock.calls[0]?.[0]).toBe(rateLimitKey('user', 'global', 'ip:5.6.7.8'));
  });

  it('keys anonymous sockets by the proxy-aware client IP of the handshake request', async () => {
    const { guard, increment } = await createGuard();
    Reflect.set(guard, 'app', { trustProxy: ['10.0.0.0/8'] });
    const socket = {
      data: {},
      handshake: { address: '10.0.0.5' },
      request: {
        socket: { remoteAddress: '10.0.0.5' },
        headers: { 'x-forwarded-for': '6.6.6.6, 1.2.3.4' },
      },
    };
    await guard.canActivate(wsContext(socket));
    expect(increment.mock.calls[0]?.[0]).toBe(rateLimitKey('user', 'global', 'ip:1.2.3.4'));
  });

  it('ignores X-Forwarded-For when no proxy is trusted (default)', async () => {
    const { guard, increment } = await createGuard();
    const socket = {
      data: {},
      handshake: { address: '10.0.0.5' },
      request: { socket: { remoteAddress: '10.0.0.5' }, headers: { 'x-forwarded-for': '1.2.3.4' } },
    };
    await guard.canActivate(wsContext(socket));
    expect(increment.mock.calls[0]?.[0]).toBe(rateLimitKey('user', 'global', 'ip:10.0.0.5'));
  });

  it('raises ThrottlerException (429) when blocked', async () => {
    const { guard, increment } = await createGuard();
    increment.mockResolvedValue(record({ isBlocked: true, timeToBlockExpire: 3 }));
    await expect(
      guard.canActivate(wsContext({ data: { user: { id: 'u-1' } } })),
    ).rejects.toBeInstanceOf(ThrottlerException);
  });

  it('skips every transport but ws', async () => {
    const { guard, increment } = await createGuard();
    await expect(
      guard.canActivate(wsContext({}, Gateway.prototype.onMessage, 'http')),
    ).resolves.toBe(true);
    expect(increment).not.toHaveBeenCalled();
  });
});

describe('throttleTracker', () => {
  it('prefers the user id, then the normalised IP', () => {
    expect(throttleTracker({ id: 'u-1' }, '1.2.3.4', 64)).toBe('user:u-1');
    expect(throttleTracker({ id: 7 }, '1.2.3.4', 64)).toBe('ip:1.2.3.4');
    expect(throttleTracker(undefined, '::ffff:10.0.0.1', 64)).toBe('ip:10.0.0.1');
    expect(throttleTracker(null, undefined, 64)).toBe('ip:unknown');
  });
});

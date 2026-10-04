import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ThrottlerException, type ThrottlerStorage } from '@nestjs/throttler';
import { describe, expect, it, vi } from 'vitest';
import type { ThrottlerStorageRecord } from './redis-throttler.storage.js';
import { throttleTracker } from './throttle-tracker.util.js';
import { WsThrottlerGuard } from './ws-throttler.guard.js';

class Gateway {
  onMessage(): void {
    // handler stub
  }
}

const record = (overrides: Partial<ThrottlerStorageRecord> = {}): ThrottlerStorageRecord => ({
  totalHits: 1,
  timeToExpire: 10,
  isBlocked: false,
  timeToBlockExpire: 0,
  ...overrides,
});

function wsContext(socket: Record<string, unknown>, type = 'ws'): ExecutionContext {
  return {
    getType: () => type,
    getHandler: () => Gateway.prototype.onMessage,
    getClass: () => Gateway,
    switchToWs: () => ({ getClient: () => socket, getData: () => ({}) }),
  } as unknown as ExecutionContext;
}

async function createGuard() {
  const increment = vi.fn<ThrottlerStorage['increment']>(async () => record());
  const guard = new WsThrottlerGuard(
    { throttlers: [{ name: 'default', ttl: 10_000, limit: 5 }] },
    { increment },
    new Reflector(),
  );
  await guard.onModuleInit();
  return { guard, increment };
}

describe('WsThrottlerGuard', () => {
  it('throttles messages per authenticated user, else per handshake address', async () => {
    const { guard, increment } = await createGuard();
    await guard.canActivate(
      wsContext({ data: { user: { id: 'u-1' } }, handshake: { address: '1.1.1.1' } }),
    );
    await guard.canActivate(wsContext({ data: {}, handshake: { address: '1.1.1.1' } }));
    expect(increment).toHaveBeenCalledTimes(2);
    const [first, second] = increment.mock.calls.map(([key]) => key);
    expect(first).not.toBe(second);
    expect(increment).toHaveBeenCalledWith(expect.any(String), 10_000, 5, 10_000, 'default');
  });

  it('rejects blocked messages with ThrottlerException', async () => {
    const { guard, increment } = await createGuard();
    increment.mockResolvedValue(record({ isBlocked: true, totalHits: 6, timeToBlockExpire: 9 }));
    await expect(guard.canActivate(wsContext({ data: {} }))).rejects.toBeInstanceOf(
      ThrottlerException,
    );
  });

  it('ignores non-WebSocket contexts', async () => {
    const { guard, increment } = await createGuard();
    await expect(guard.canActivate(wsContext({}, 'http'))).resolves.toBe(true);
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

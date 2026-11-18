import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ThrottlerException, type ThrottlerStorage } from '@nestjs/throttler';
import { register } from 'prom-client';
import { describe, expect, it, vi } from 'vitest';
import { RateLimitGuardBase, type RateLimitSubject } from './rate-limit-guard.base.js';
import type { RateLimitDecision } from './rate-limit-headers.js';
import { RATE_LIMIT_DECISIONS_TOTAL } from './rate-limit-metrics.js';
import type { ThrottlerStorageRecord } from './redis-throttler.storage.js';
import { THROTTLER } from './throttle.constants.js';
import { WsThrottlerGuard } from './ws-throttler.guard.js';

type Sample = { labels: Record<string, string | number>; value: number };

async function count(throttler: string, scope: string, outcome: string): Promise<number> {
  const metric = register.getSingleMetric(RATE_LIMIT_DECISIONS_TOTAL);
  if (metric === undefined) return 0;
  const values = (await metric.get()).values as Sample[];
  const hit = values.find(
    (s) =>
      s.labels['throttler'] === throttler &&
      s.labels['scope'] === scope &&
      s.labels['outcome'] === outcome,
  );
  return hit?.value ?? 0;
}

/** Exposes `recordDecision`; `res` decides whether the header path is taken. */
class ProbeGuard extends RateLimitGuardBase {
  protected override readonly enforced: ReadonlySet<string> = new Set<string>();
  res: Record<string, unknown> | undefined = { header: vi.fn() };

  protected override subjectOf(): RateLimitSubject {
    return {};
  }

  protected override responseOf(): Record<string, unknown> | undefined {
    return this.res;
  }

  record(decision: RateLimitDecision): void {
    this.recordDecision({} as ExecutionContext, decision);
  }
}

const probe = () => new ProbeGuard({ throttlers: [] }, { increment: vi.fn() }, new Reflector());

const decision = (overrides: Partial<RateLimitDecision> = {}): RateLimitDecision => ({
  throttler: THROTTLER.ROUTE,
  scope: 'guard-base.spec',
  limit: 5,
  ttlMs: 10_000,
  remaining: 4,
  resetSeconds: 10,
  blocked: false,
  retryAfterSeconds: 0,
  ...overrides,
});

const record = (overrides: Partial<ThrottlerStorageRecord> = {}): ThrottlerStorageRecord => ({
  totalHits: 1,
  timeToExpire: 10,
  isBlocked: false,
  timeToBlockExpire: 0,
  ...overrides,
});

describe('RateLimitGuardBase.recordDecision (G-10 decision metrics)', () => {
  it('counts a decision that also writes headers', async () => {
    const guard = probe();
    const before = await count('route', 'guard-base.spec', 'allowed');
    guard.record(decision());
    expect(await count('route', 'guard-base.spec', 'allowed')).toBe(before + 1);
  });

  it('counts the lockout bucket although it returns before the headers', async () => {
    const guard = probe();
    const res = { header: vi.fn() };
    guard.res = res;
    const before = await count('lockout', 'guard-base.spec', 'blocked');
    guard.record(
      decision({
        throttler: THROTTLER.LOCKOUT,
        blocked: true,
        remaining: 0,
        retryAfterSeconds: 60,
      }),
    );
    expect(await count('lockout', 'guard-base.spec', 'blocked')).toBe(before + 1);
    expect(res.header).not.toHaveBeenCalled();
  });

  it('counts a decision of a transport without headers (no response)', async () => {
    const guard = probe();
    guard.res = undefined;
    const before = await count('route', 'guard-base.spec', 'allowed');
    guard.record(decision());
    expect(await count('route', 'guard-base.spec', 'allowed')).toBe(before + 1);
  });

  it('counts each WebSocket message decision once, allowed then blocked', async () => {
    const increment = vi.fn<ThrottlerStorage['increment']>(async () => record());
    const guard = new WsThrottlerGuard(
      { throttlers: [{ name: THROTTLER.USER, ttl: 60_000, limit: 100 }] },
      { increment },
      new Reflector(),
    );
    await guard.onModuleInit();
    const socket = { data: { user: { id: 'u-1' } } };
    const ws = {
      getType: () => 'ws',
      getHandler: () => () => undefined,
      getClass: () => Object,
      switchToWs: () => ({ getClient: () => socket, getData: () => ({}) }),
    } as unknown as ExecutionContext;
    const allowed = await count('user', 'global', 'allowed');
    const blocked = await count('user', 'global', 'blocked');
    await guard.canActivate(ws);
    increment.mockResolvedValueOnce(record({ isBlocked: true, timeToBlockExpire: 5 }));
    await expect(guard.canActivate(ws)).rejects.toBeInstanceOf(ThrottlerException);
    expect(await count('user', 'global', 'allowed')).toBe(allowed + 1);
    expect(await count('user', 'global', 'blocked')).toBe(blocked + 1);
  });
});

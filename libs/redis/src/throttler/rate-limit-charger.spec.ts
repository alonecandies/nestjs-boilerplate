import { describe, expect, it, vi } from 'vitest';
import { RateLimitCharger } from './rate-limit-charger.js';
import { rateLimitKey } from './rate-limit-key.util.js';

describe('RateLimitCharger', () => {
  it('increments the bucket by weight and returns the IETF decision', async () => {
    const incrementBy = vi.fn(async () => ({
      totalHits: 150,
      timeToExpire: 30,
      isBlocked: false,
      timeToBlockExpire: 0,
    }));
    const charger = new RateLimitCharger({ increment: vi.fn(), incrementBy });
    const bucket = {
      throttler: 'graphql',
      scope: 'cost',
      tracker: 'user:u-1',
      limit: 1_000,
      ttlMs: 60_000,
      blockMs: 60_000,
    };
    const { decision } = await charger.charge(bucket, 50);
    expect(incrementBy).toHaveBeenCalledWith(
      rateLimitKey('graphql', 'cost', 'user:u-1'),
      60_000,
      1_000,
      60_000,
      'graphql',
      50,
    );
    expect(decision).toMatchObject({
      throttler: 'graphql',
      scope: 'cost',
      remaining: 850,
      resetSeconds: 30,
      blocked: false,
    });
  });

  it('falls back to increment() (weight 1) for storages without incrementBy', async () => {
    const increment = vi.fn(async () => ({
      totalHits: 1,
      timeToExpire: 60,
      isBlocked: false,
      timeToBlockExpire: 0,
    }));
    const charger = new RateLimitCharger({ increment });
    await charger.charge(
      { throttler: 'graphql', scope: 'cost', tracker: 't', limit: 5, ttlMs: 1_000, blockMs: 0 },
      7,
    );
    expect(increment).toHaveBeenCalledTimes(1);
  });
});

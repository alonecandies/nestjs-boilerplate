import { RateLimitCharger } from '@platform/redis';
import { buildSchema, parse } from 'graphql';
import { describe, expect, it, vi } from 'vitest';
import { createSubscriptionCheck, SubscriptionGuardRef } from './subscription-guard.js';

const schema = buildSchema('type Query { a: Int } type Subscription { tick: Int items: [Int] }');
const input = (query: string, user: unknown = { id: 'u-1' }, ip = '1.2.3.4') => ({
  document: parse(query),
  user,
  ip,
});

// The real tracker rule (user id, else IP with IPv6 collapsed to its subnet); only `charge` is faked.
const realCharger = new RateLimitCharger({ increment: vi.fn() });

const charger = (blocked = false) => ({
  trackerFor: (user: unknown, ip: unknown) => realCharger.trackerFor(user, ip),
  charge: vi.fn(async (_bucket: { tracker: string }, _weight?: number) => ({
    record: {
      totalHits: 1,
      timeToExpire: 60,
      isBlocked: blocked,
      timeToBlockExpire: blocked ? 9 : 0,
    },
    decision: {} as never,
  })),
});

describe('graphql-ws subscription check (C-6)', () => {
  it('rejects a subscription above GRAPHQL_MAX_COMPLEXITY with QUERY_TOO_COMPLEX', async () => {
    const check = createSubscriptionCheck({
      schema: () => schema,
      maxComplexity: 1,
      costLimit: 100,
      costTtlMs: 60_000,
      charger: undefined,
    });
    const errors = await check(input('subscription { tick items }'));
    expect(errors?.[0]?.extensions).toMatchObject({
      code: 'QUERY_TOO_COMPLEX',
      complexity: 2,
      maxComplexity: 1,
    });
  });

  it('charges the graphql cost budget once per subscription, keyed by user, weighted by cost', async () => {
    const limiter = charger();
    const check = createSubscriptionCheck({
      schema: () => schema,
      maxComplexity: 100,
      costLimit: 100,
      costTtlMs: 60_000,
      charger: limiter as never,
    });
    await expect(check(input('subscription { tick items }'))).resolves.toBeUndefined();
    expect(limiter.charge).toHaveBeenCalledWith(
      expect.objectContaining({
        throttler: 'graphql',
        scope: 'cost',
        tracker: 'user:u-1',
        limit: 100,
      }),
      2,
    );
  });

  it('charges an anonymous subscription to the client IP, IPv6 collapsed to its /64', async () => {
    const limiter = charger();
    const check = createSubscriptionCheck({
      schema: () => schema,
      maxComplexity: 100,
      costLimit: 100,
      costTtlMs: 60_000,
      charger: limiter as never,
    });
    await check(input('subscription { tick }', null, '2001:db8:1:2:aaaa::1'));
    await check(input('subscription { tick }', null, '2001:db8:1:2:bbbb::9'));
    const trackers = limiter.charge.mock.calls.map(([bucket]) => bucket.tracker);
    expect(trackers[0]).toBe(trackers[1]);
    expect(trackers[0]).toMatch(/^ip:/);
  });

  it('rejects a fully limited subscription with RATE_LIMITED and retryAfterSeconds', async () => {
    const check = createSubscriptionCheck({
      schema: () => schema,
      maxComplexity: 100,
      costLimit: 1,
      costTtlMs: 60_000,
      charger: charger(true) as never,
    });
    const errors = await check(input('subscription { tick }', undefined));
    expect(errors?.[0]?.extensions).toMatchObject({ code: 'RATE_LIMITED', retryAfterSeconds: 9 });
  });

  it('an unbound ref lets everything through', async () => {
    await expect(
      new SubscriptionGuardRef().run(input('subscription { tick }')),
    ).resolves.toBeUndefined();
  });
});

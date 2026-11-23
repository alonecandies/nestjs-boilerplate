import { describe, expect, it } from 'vitest';
import {
  collectDecision,
  formatRateLimit,
  formatRateLimitPolicy,
  policyItemName,
  type RateLimitDecision,
} from './rate-limit-headers.js';

const decision = (overrides: Partial<RateLimitDecision>): RateLimitDecision => ({
  throttler: 'user',
  scope: 'global',
  limit: 100,
  ttlMs: 60_000,
  remaining: 99,
  resetSeconds: 60,
  blocked: false,
  retryAfterSeconds: 0,
  ...overrides,
});

describe('IETF RateLimit headers (draft-ietf-httpapi-ratelimit-headers-11)', () => {
  it('names global budgets by throttler and policy budgets by throttler:policy', () => {
    expect(policyItemName({ throttler: 'ip', scope: 'global' })).toBe('ip');
    expect(policyItemName({ throttler: 'route', scope: 'files.upload' })).toBe(
      'route:files.upload',
    );
  });

  it('formats RateLimit-Policy (q, w in whole seconds, at least 1)', () => {
    expect(
      formatRateLimitPolicy([
        decision({ throttler: 'ip', limit: 600 }),
        decision({ throttler: 'route', scope: 'files.upload', limit: 3, ttlMs: 10_500 }),
        decision({ throttler: 'auth', scope: 'x.y', ttlMs: 10 }),
      ]),
    ).toBe('"ip";q=600;w=60, "route:files.upload";q=3;w=11, "auth:x.y";q=100;w=1');
  });

  it('formats RateLimit (r, t)', () => {
    expect(formatRateLimit([decision({ remaining: 0, resetSeconds: 42 })])).toBe('"user";r=0;t=42');
  });

  it('collects decisions per response, one per name, fixed order', () => {
    const res = {};
    collectDecision(res, decision({ throttler: 'route', scope: 'a.b', remaining: 5 }));
    collectDecision(res, decision({ throttler: 'user', remaining: 9 }));
    collectDecision(res, decision({ throttler: 'ip', remaining: 7 }));
    const all = collectDecision(res, decision({ throttler: 'route', scope: 'a.b', remaining: 4 }));
    expect(all.map((d) => [policyItemName(d), d.remaining])).toEqual([
      ['ip', 7],
      ['user', 9],
      ['route:a.b', 4],
    ]);
    expect(collectDecision({}, decision({}))).toHaveLength(1);
  });

  describe('two decisions for one name keep the most restrictive', () => {
    const names = (all: RateLimitDecision[]) => all.map((d) => [policyItemName(d), d.remaining]);

    it('keeps the lower remaining in either order', () => {
      const low = decision({ remaining: 4 });
      const high = decision({ remaining: 99 });
      const a = {};
      collectDecision(a, low);
      expect(names(collectDecision(a, high))).toEqual([['user', 4]]);
      const b = {};
      collectDecision(b, high);
      expect(names(collectDecision(b, low))).toEqual([['user', 4]]);
    });

    it('keeps a blocked decision in either order', () => {
      const blocked = decision({ remaining: 0, blocked: true, retryAfterSeconds: 7 });
      const open = decision({ remaining: 0, blocked: false });
      const a = {};
      collectDecision(a, blocked);
      expect(collectDecision(a, open)[0]?.blocked).toBe(true);
      const b = {};
      collectDecision(b, open);
      expect(collectDecision(b, blocked)[0]?.blocked).toBe(true);
    });

    it('lets a blocked decision win over a lower remaining one', () => {
      const res = {};
      collectDecision(res, decision({ remaining: 0, blocked: false }));
      const [kept] = collectDecision(res, decision({ remaining: 3, blocked: true }));
      expect(kept?.blocked).toBe(true);
    });

    it('breaks a remaining tie with the larger reset', () => {
      const a = {};
      collectDecision(a, decision({ remaining: 4, resetSeconds: 10 }));
      expect(
        collectDecision(a, decision({ remaining: 4, resetSeconds: 50 }))[0]?.resetSeconds,
      ).toBe(50);
      const b = {};
      collectDecision(b, decision({ remaining: 4, resetSeconds: 50 }));
      expect(
        collectDecision(b, decision({ remaining: 4, resetSeconds: 10 }))[0]?.resetSeconds,
      ).toBe(50);
    });
  });
});

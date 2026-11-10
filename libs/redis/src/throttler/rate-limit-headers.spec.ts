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

  it('collects decisions per response, last one per name wins, fixed order', () => {
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
});

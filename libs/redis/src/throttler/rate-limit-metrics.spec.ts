import { register } from 'prom-client';
import { describe, expect, it } from 'vitest';
import type { RateLimitDecision } from './rate-limit-headers.js';
import { RATE_LIMIT_DECISIONS_TOTAL, recordRateLimitDecision } from './rate-limit-metrics.js';

type Sample = { labels: Record<string, string | number>; value: number };

/** The value of one series of `rate_limit_decisions_total` (0 when absent). */
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

const decision = (overrides: Partial<RateLimitDecision> = {}): RateLimitDecision => ({
  throttler: 'route',
  scope: 'metrics.spec',
  limit: 3,
  ttlMs: 60_000,
  remaining: 2,
  resetSeconds: 60,
  blocked: false,
  retryAfterSeconds: 0,
  ...overrides,
});

describe('recordRateLimitDecision', () => {
  it('counts an allowed decision under outcome="allowed"', async () => {
    const before = await count('route', 'metrics.spec', 'allowed');
    const blockedBefore = await count('route', 'metrics.spec', 'blocked');
    recordRateLimitDecision(decision());
    expect(await count('route', 'metrics.spec', 'allowed')).toBe(before + 1);
    expect(await count('route', 'metrics.spec', 'blocked')).toBe(blockedBefore);
  });

  it('counts a blocked decision under outcome="blocked"', async () => {
    const allowedBefore = await count('auth', 'metrics.spec', 'allowed');
    const before = await count('auth', 'metrics.spec', 'blocked');
    recordRateLimitDecision(
      decision({ throttler: 'auth', blocked: true, remaining: 0, retryAfterSeconds: 9 }),
    );
    expect(await count('auth', 'metrics.spec', 'blocked')).toBe(before + 1);
    expect(await count('auth', 'metrics.spec', 'allowed')).toBe(allowedBefore);
  });

  it('labels every series with exactly throttler, scope and outcome (no tracker, key or tenant)', async () => {
    recordRateLimitDecision(decision({ scope: 'metrics.labels' }));
    const metric = register.getSingleMetric(RATE_LIMIT_DECISIONS_TOTAL);
    expect(metric).toBeDefined();
    const values = ((await metric?.get())?.values ?? []) as Sample[];
    expect(values.length).toBeGreaterThan(0);
    for (const sample of values) {
      expect(Object.keys(sample.labels).sort()).toEqual(['outcome', 'scope', 'throttler']);
    }
    const text = await register.getSingleMetricAsString(RATE_LIMIT_DECISIONS_TOTAL);
    expect(text).toContain('# TYPE rate_limit_decisions_total counter');
  });
});

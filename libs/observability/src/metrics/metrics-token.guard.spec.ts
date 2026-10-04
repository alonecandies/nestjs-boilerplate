import type { ObservabilityConfig } from '@app/config';
import { type ExecutionContext, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { MetricsTokenGuard } from './metrics-token.guard.js';

const TOKEN = 'scrape-token-0123456789abcdef';

const contextWith = (headers: Record<string, string>): ExecutionContext =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  }) as unknown as ExecutionContext;

const guardWith = (metricsBearerToken?: string): MetricsTokenGuard =>
  new MetricsTokenGuard({ metricsBearerToken } as ObservabilityConfig);

describe('MetricsTokenGuard', () => {
  it('lets every scrape through when no token is configured', () => {
    expect(guardWith().canActivate(contextWith({}))).toBe(true);
  });

  it('answers 404 (not 401) when the bearer token is missing or wrong', () => {
    const guard = guardWith(TOKEN);
    const cases: Record<string, string>[] = [
      {},
      { authorization: TOKEN },
      { authorization: 'Bearer nope' },
      { authorization: `Basic ${TOKEN}` },
    ];
    for (const headers of cases) {
      expect(() => guard.canActivate(contextWith(headers))).toThrow(NotFoundException);
    }
  });

  it('accepts the configured bearer token', () => {
    expect(guardWith(TOKEN).canActivate(contextWith({ authorization: `Bearer ${TOKEN}` }))).toBe(
      true,
    );
    expect(guardWith(TOKEN).canActivate(contextWith({ authorization: `bearer  ${TOKEN}` }))).toBe(
      true,
    );
  });
});

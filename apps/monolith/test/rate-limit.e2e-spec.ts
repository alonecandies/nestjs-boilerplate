await vi.hoisted(async () => {
  const { MONOLITH_E2E_ENV } = await import('./support/e2e-env.js');
  Object.assign(process.env, MONOLITH_E2E_ENV, {
    THROTTLE_IP_LIMIT: '40',
    THROTTLE_LIMIT: '1000',
    IDENTITY_CREDENTIALS_LIMIT: '4',
    IDENTITY_LOCKOUT_THRESHOLD: '50',
  });
});

import { generateId } from '@platform/common';
import { MetricsListener } from '@platform/observability';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bearer, expectProblem, graphql } from './support/http.js';
import { createMonolithE2eApp, type MonolithE2e } from './support/monolith-e2e-app.js';

const LOGIN = 'mutation Login($input: LoginInput!) { login(input: $input) { accessToken } }';
const WRONG = 'wrong password!!';

/** `rate_limit_decisions_total` series of one scrape, keyed `throttler|scope|outcome`. */
function decisionSeries(body: string): Map<string, number> {
  const series = new Map<string, number>();
  for (const line of body.split('\n')) {
    const match = /^rate_limit_decisions_total\{([^}]*)\} (\S+)$/.exec(line);
    if (match === null) continue;
    const labels = Object.fromEntries(
      [...(match[1] ?? '').matchAll(/(\w+)="([^"]*)"/g)].map(([, name, value]) => [name, value]),
    );
    expect(Object.keys(labels).sort()).toEqual(['outcome', 'scope', 'throttler']);
    series.set(`${labels['throttler']}|${labels['scope']}|${labels['outcome']}`, Number(match[2]));
  }
  return series;
}

describe('monolith rate limits (spec §11, wave 1)', () => {
  let e2e: MonolithE2e;
  const inject = (...args: Parameters<MonolithE2e['app']['inject']>) => e2e.app.inject(...args);
  const rest = (email: string) =>
    inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: WRONG } });

  beforeAll(async () => {
    e2e = await createMonolithE2eApp();
  });
  beforeEach(async () => {
    await e2e.redis.flushall();
  });
  afterAll(async () => {
    await e2e?.app.close();
  });

  it('sends IETF RateLimit-Policy / RateLimit for every budget charged', async () => {
    const response = await rest('nobody@example.com');
    expect(response.statusCode).toBe(401);
    expect(response.headers['ratelimit-policy']).toBe(
      '"ip";q=40;w=60, "user";q=1000;w=60, "auth:identity.credentials";q=4;w=60',
    );
    expect(response.headers['ratelimit']).toBe(
      '"ip";r=39;t=60, "user";r=999;t=60, "auth:identity.credentials";r=3;t=60',
    );
    expect(response.headers['x-ratelimit-limit']).toBeUndefined();
  });

  it('shares one credential bucket between REST and GraphQL, keyed by the normalised email (F17)', async () => {
    const gql = (email: string) => inject(graphql(LOGIN, { input: { email, password: WRONG } }));
    expect((await rest('Bob@Example.com')).statusCode).toBe(401);
    expect((await rest(' bob@example.com')).statusCode).toBe(401);
    const viaGraphql = await gql('BOB@example.com');
    const errors = viaGraphql.json<{ errors: { extensions: { code: string } }[] }>().errors;
    expect(errors[0]?.extensions.code).toBe('INVALID_CREDENTIALS');
    await gql('bob@example.com');
    const limited = await rest('bob@example.com');
    expectProblem(limited, 429, 'RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(String(limited.headers['ratelimit'])).toContain('"auth:identity.credentials";r=0');
    // Another account from the same IP is not affected.
    expect((await rest('carol@example.com')).statusCode).toBe(401);
  });

  it('counts unauthenticated floods before the token is checked; X-Forwarded-For cannot dodge it (TRUST_PROXY=false)', async () => {
    for (let i = 0; i < 40; i += 1) {
      const response = await inject({
        method: 'GET',
        url: '/v1/auth/me',
        headers: { authorization: 'Bearer nope', 'x-forwarded-for': `203.0.113.${i}` },
      });
      expect(response.statusCode).toBe(401);
    }
    const limited = await inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { 'x-forwarded-for': '198.51.100.7' },
    });
    expectProblem(limited, 429, 'RATE_LIMITED');
    expect((await inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200);
  });

  it('limits REST mark-read to NOTIFICATIONS_MARK_READ_LIMIT (30) per window per user (F4)', async () => {
    const registered = await inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'erin@example.com',
        password: 'correct horse battery',
        displayName: 'Erin',
      },
    });
    expect(registered.statusCode, registered.body).toBe(201);
    const { accessToken } = registered.json<{ accessToken: string }>();
    const mark = () =>
      inject({
        method: 'POST',
        url: `/v1/notifications/${generateId()}/read`,
        headers: bearer(accessToken),
      });
    // The policy is checked before the handler: unknown ids (404) count too.
    for (let i = 0; i < 30; i += 1) expect((await mark()).statusCode).toBe(404);
    const limited = await mark();
    expectProblem(limited, 429, 'RATE_LIMITED');
    expect(String(limited.headers['ratelimit'])).toContain('"route:notifications.mark-read";r=0');
  });

  it('never throttles the Stripe webhook (SkipRateLimit covers every throttler)', async () => {
    for (let i = 0; i < 50; i += 1) {
      const response = await inject({
        method: 'POST',
        url: '/v1/billing/webhooks/stripe',
        headers: { 'content-type': 'application/json' },
        payload: '{"id":"evt_1"}',
      });
      expect(response.statusCode).not.toBe(429);
    }
  });

  it('counts every decision in rate_limit_decisions_total by throttler, scope and outcome (G-10)', async () => {
    const scrape = async () => {
      const result = await e2e.app.get(MetricsListener, { strict: false }).scrape();
      expect(result.status).toBe(200);
      return decisionSeries(result.body);
    };
    const delta = (after: Map<string, number>, before: Map<string, number>, series: string) =>
      (after.get(series) ?? 0) - (before.get(series) ?? 0);
    const before = await scrape();
    // IDENTITY_CREDENTIALS_LIMIT=4 in this file: four allowed, then the fifth is refused.
    for (let i = 0; i < 4; i += 1) expect((await rest('metrics@example.com')).statusCode).toBe(401);
    expectProblem(await rest('metrics@example.com'), 429, 'RATE_LIMITED');
    const afterRest = await scrape();
    expect(delta(afterRest, before, 'auth|identity.credentials|allowed')).toBe(4);
    expect(delta(afterRest, before, 'auth|identity.credentials|blocked')).toBe(1);
    expect(delta(afterRest, before, 'graphql|cost|allowed')).toBe(0);

    // A cost-charged GraphQL operation: the cost budget is charged (and counted) exactly once.
    await inject(graphql(LOGIN, { input: { email: 'metrics-gql@example.com', password: WRONG } }));
    const afterGraphql = await scrape();
    expect(delta(afterGraphql, afterRest, 'graphql|cost|allowed')).toBe(1);
    expect(delta(afterGraphql, afterRest, 'graphql|cost|blocked')).toBe(0);
  });

  it('Redis down: credential endpoints fail closed (503), other budgets fail open', async () => {
    e2e.redis.simulateOutage();
    try {
      expectProblem(await rest('dave@example.com'), 503, 'SERVICE_UNAVAILABLE');
      const refresh = await inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        payload: { refreshToken: 'not-a-jwt' },
      });
      // The ip/user budgets let it through: the handler answers (4xx), not the limiter (503).
      expect([400, 401]).toContain(refresh.statusCode);
    } finally {
      e2e.redis.status = 'ready';
    }
  });
});

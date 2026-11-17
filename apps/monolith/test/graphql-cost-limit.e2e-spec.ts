/*
 * The GraphQL cost budget over HTTP (C-5): keyed by the verified user even though the plugin runs
 * before JwtAuthGuard, so users behind one IP (NAT, corporate egress) do not share a budget.
 */
await vi.hoisted(async () => {
  const { MONOLITH_E2E_ENV } = await import('./support/e2e-env.js');
  Object.assign(process.env, MONOLITH_E2E_ENV, { THROTTLE_GRAPHQL_COST_LIMIT: '30' });
});

import { AccessTokenDenylist } from '@platform/auth';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bearer, graphql } from './support/http.js';
import { createMonolithE2eApp, type MonolithE2e } from './support/monolith-e2e-app.js';

/** Complexity 12, so the third run in one window exceeds the budget of 30. */
const USERS = '{ users(limit: 1) { items { id } } }';

interface GraphqlBody {
  data?: unknown;
  errors?: { extensions?: { code?: string } }[];
}

describe('GraphQL cost budget per user (monolith)', () => {
  let e2e: MonolithE2e;
  let alice: string;
  let bob: string;

  const register = async (email: string): Promise<string> => {
    const res = await e2e.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email, password: 'correct horse battery staple', displayName: email },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ accessToken: string }>().accessToken;
  };
  const query = (token: string) => e2e.app.inject(graphql(USERS, undefined, bearer(token)));

  beforeAll(async () => {
    e2e = await createMonolithE2eApp();
    alice = await register('alice.cost@example.com');
    bob = await register('bob.cost@example.com');
  });
  beforeEach(async () => {
    await e2e.redis.flushall();
  });
  afterAll(async () => {
    await e2e?.app.close();
  });

  it('gives two authenticated users from the same IP separate graphql:cost buckets', async () => {
    let limited: Awaited<ReturnType<typeof query>> | undefined;
    for (let i = 0; i < 20 && limited === undefined; i += 1) {
      const res = await query(alice);
      if (res.statusCode === 429) limited = res;
      else expect(res.json<GraphqlBody>().errors, res.body).toBeUndefined();
    }
    expect(limited, 'alice never reached her cost budget').toBeDefined();
    expect(limited?.json<GraphqlBody>().errors?.[0]?.extensions?.code).toBe('RATE_LIMITED');
    expect(Number(limited?.headers['retry-after'])).toBeGreaterThan(0);

    // Same IP (inject's 127.0.0.1), other user: a fresh budget, not alice's exhausted one.
    const other = await query(bob);
    expect(other.statusCode, other.body).toBe(200);
    expect(other.json<GraphqlBody>().errors).toBeUndefined();
    expect(String(other.headers['ratelimit'])).toContain('"graphql:cost";r=18;');
    expect(String(other.headers['ratelimit-policy'])).toContain('"graphql:cost";q=30;w=60');
  });

  it('verifies the bearer token and reads the denylist once per HTTP operation', async () => {
    // The plugin verifies the token to key the budget; JwtAuthGuard reuses that user.
    const isDenied = vi.spyOn(e2e.app.get(AccessTokenDenylist), 'isDenied');
    try {
      const me = await e2e.app.inject(graphql('{ me { id } }', undefined, bearer(alice)));
      expect(me.statusCode, me.body).toBe(200);
      expect(me.json<GraphqlBody>().errors, me.body).toBeUndefined();
      expect(isDenied).toHaveBeenCalledTimes(1);
    } finally {
      isDenied.mockRestore();
    }
  });

  it('charges an anonymous operation to the IP, apart from the users behind it', async () => {
    const anonymous = await e2e.app.inject(graphql(USERS));
    const viaUser = await query(alice);
    // Both are first charges of their own bucket (30 - 12); a shared bucket would leave 6.
    expect(String(anonymous.headers['ratelimit'])).toContain('"graphql:cost";r=18;');
    expect(String(viaUser.headers['ratelimit'])).toContain('"graphql:cost";r=18;');
  });
});

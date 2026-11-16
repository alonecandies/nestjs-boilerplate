import type { GraphQLSchemaHost } from '@nestjs/graphql';
import type { AccessTokenDenylist, TokenService } from '@platform/auth';
import { throttleConfig } from '@platform/config';
import { RateLimitCharger } from '@platform/redis';
import { buildSchema, GraphQLError, parse } from 'graphql';
import { describe, expect, it, vi } from 'vitest';
import { OperationRateLimitPlugin } from './operation-rate-limit.plugin.js';

const schema = buildSchema('type Query { a: Int b: Int items: [Int] }');

/** Tokens `token-<user>` verify as `<user>`; `token-revoked` is on the denylist; others are invalid. */
const tokens = {
  verifyAccessToken: vi.fn(async (token: string) => {
    if (!token.startsWith('token-')) throw new Error('invalid signature');
    const sub = token.slice('token-'.length);
    return { sub, jti: `jti-${sub}` };
  }),
  toAuthUser: (claims: { sub: string }) => ({ id: claims.sub }),
} as unknown as TokenService;
const denylist = {
  isDenied: vi.fn(async (jti: string) => jti === 'jti-revoked'),
} as unknown as AccessTokenDenylist;

function setup(
  record = { totalHits: 1, timeToExpire: 60, isBlocked: false, timeToBlockExpire: 0 },
) {
  const charge = vi.fn(
    async (
      bucket: { limit: number; throttler: string; scope: string; ttlMs: number },
      weight = 1,
    ) => ({
      record,
      decision: {
        throttler: bucket.throttler,
        scope: bucket.scope,
        limit: bucket.limit,
        ttlMs: bucket.ttlMs,
        remaining: record.isBlocked ? 0 : bucket.limit - weight,
        resetSeconds: record.isBlocked ? record.timeToBlockExpire : record.timeToExpire,
        blocked: record.isBlocked,
        retryAfterSeconds: record.timeToBlockExpire,
      },
    }),
  );
  const real = new RateLimitCharger({ increment: vi.fn() });
  const plugin = new OperationRateLimitPlugin(
    { schema } as unknown as GraphQLSchemaHost,
    throttleConfig.parse({ THROTTLE_GRAPHQL_COST_LIMIT: '100' }),
    tokens,
    denylist,
    { charge, trackerFor: real.trackerFor.bind(real) } as never,
  );
  return { plugin, charge };
}

async function run(
  plugin: OperationRateLimitPlugin,
  query: string,
  contextValue: Record<string, unknown>,
) {
  const { done, headers } = await runWithReply(plugin, query, contextValue);
  await done;
  return headers;
}

async function runWithReply(
  plugin: OperationRateLimitPlugin,
  query: string,
  contextValue: Record<string, unknown>,
) {
  const listener = await plugin.requestDidStart();
  const headers = new Map<string, string>();
  const reply = { header: vi.fn((name: string, value: string) => headers.set(name, value)) };
  const done = listener.didResolveOperation?.({
    request: { query },
    document: parse(query),
    contextValue: { reply, ...contextValue },
    response: { http: { headers: new Map(), status: undefined } },
  } as never);
  return { done, headers, reply };
}

const trackerOf = (charge: ReturnType<typeof setup>['charge'], call = 0) =>
  (charge.mock.calls[call]?.[0] as { tracker?: string } | undefined)?.tracker;

describe('OperationRateLimitPlugin', () => {
  it('charges once per operation with weight = complexity, keyed by user', async () => {
    const { plugin, charge } = setup();
    const headers = await run(plugin, '{ a b items }', {
      req: { user: { id: 'u-1' }, ip: '1.2.3.4' },
    });
    expect(charge).toHaveBeenCalledTimes(1);
    expect(charge).toHaveBeenCalledWith(
      expect.objectContaining({
        throttler: 'graphql',
        scope: 'cost',
        tracker: 'user:u-1',
        limit: 100,
      }),
      3,
    );
    expect(headers.get('ratelimit-policy')).toBe('"graphql:cost";q=100;w=60');
  });

  it('falls back to the client IP and skips introspection-only operations', async () => {
    const { plugin, charge } = setup();
    await run(plugin, '{ a }', { req: { ip: '1.2.3.4' } });
    expect(charge.mock.calls[0]?.[0]).toMatchObject({ tracker: 'ip:1.2.3.4' });
    charge.mockClear();
    await run(plugin, '{ __schema { queryType { name } } }', { req: { ip: '1.2.3.4' } });
    expect(charge).not.toHaveBeenCalled();
  });

  it('rejects a fully limited operation with HTTP 429 RATE_LIMITED and Retry-After', async () => {
    const { plugin } = setup({
      totalHits: 101,
      timeToExpire: 0,
      isBlocked: true,
      timeToBlockExpire: 17,
    });
    const { done, reply } = await runWithReply(plugin, '{ a }', { req: { user: { id: 'u-1' } } });
    const error = await done?.then(
      () => undefined,
      (rejected: unknown) => rejected,
    );
    expect(error).toBeInstanceOf(GraphQLError);
    expect(error).toMatchObject({ extensions: { code: 'RATE_LIMITED', http: { status: 429 } } });
    const http = (error as GraphQLError).extensions['http'] as { headers: Map<string, string> };
    expect(http.headers.get('retry-after')).toBe('17');
    expect(reply.header).toHaveBeenCalledWith('retry-after', '17');
    expect(reply.header).toHaveBeenCalledWith('ratelimit', '"graphql:cost";r=0;t=17');
  });

  it('keys an HTTP operation by the verified bearer token: users behind one IP get their own budget', async () => {
    const { plugin, charge } = setup();
    const from = (token: string) => ({
      req: { ip: '1.2.3.4', headers: { authorization: `Bearer ${token}` } },
    });
    await run(plugin, '{ a }', from('token-alice'));
    await run(plugin, '{ a }', from('token-bob'));
    expect(trackerOf(charge, 0)).toBe('user:alice');
    expect(trackerOf(charge, 1)).toBe('user:bob');
  });

  it('charges the IP when the bearer token is invalid or revoked', async () => {
    const { plugin, charge } = setup();
    const from = (authorization: string) => ({
      req: { ip: '1.2.3.4', headers: { authorization } },
    });
    await run(plugin, '{ a }', from('Bearer forged'));
    await run(plugin, '{ a }', from('Bearer token-revoked'));
    await run(plugin, '{ a }', from('Basic token-alice'));
    expect([0, 1, 2].map((call) => trackerOf(charge, call))).toEqual([
      'ip:1.2.3.4',
      'ip:1.2.3.4',
      'ip:1.2.3.4',
    ]);
  });

  it('collapses IPv6 clients to their /64, like the guards', async () => {
    const { plugin, charge } = setup();
    await run(plugin, '{ a }', { req: { ip: '2001:db8:1:2:aaaa::1' } });
    await run(plugin, '{ a }', { req: { ip: '2001:db8:1:2:bbbb:cccc:dddd:2' } });
    await run(plugin, '{ a }', { req: { ip: '2001:db8:1:3::1' } });
    expect(trackerOf(charge, 0)).toBe(trackerOf(charge, 1));
    expect(trackerOf(charge, 2)).not.toBe(trackerOf(charge, 0));
  });

  it('is a no-op without a charger (apps without AppThrottlerModule)', async () => {
    const plugin = new OperationRateLimitPlugin(
      { schema } as unknown as GraphQLSchemaHost,
      throttleConfig.parse({}),
      tokens,
      denylist,
      undefined,
    );
    await expect(run(plugin, '{ a }', { req: {} })).resolves.toBeInstanceOf(Map);
  });
});

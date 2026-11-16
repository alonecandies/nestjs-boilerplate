import type { GraphQLSchemaHost } from '@nestjs/graphql';
import { throttleConfig } from '@platform/config';
import { buildSchema, GraphQLError, parse } from 'graphql';
import { describe, expect, it, vi } from 'vitest';
import { OperationRateLimitPlugin } from './operation-rate-limit.plugin.js';

const schema = buildSchema('type Query { a: Int b: Int items: [Int] }');

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
  const plugin = new OperationRateLimitPlugin(
    { schema } as unknown as GraphQLSchemaHost,
    throttleConfig.parse({ THROTTLE_GRAPHQL_COST_LIMIT: '100' }),
    { charge } as never,
  );
  return { plugin, charge };
}

async function run(
  plugin: OperationRateLimitPlugin,
  query: string,
  contextValue: Record<string, unknown>,
) {
  const listener = await plugin.requestDidStart();
  const headers = new Map<string, string>();
  const reply = { header: vi.fn((name: string, value: string) => headers.set(name, value)) };
  await listener.didResolveOperation?.({
    request: { query },
    document: parse(query),
    contextValue: { reply, ...contextValue },
    response: { http: { headers: new Map(), status: undefined } },
  } as never);
  return headers;
}

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
    const rejection = run(plugin, '{ a }', { req: { user: { id: 'u-1' } } });
    await expect(rejection).rejects.toBeInstanceOf(GraphQLError);
    await expect(rejection).rejects.toMatchObject({
      extensions: { code: 'RATE_LIMITED', http: { status: 429, headers: expect.any(Map) } },
    });
  });

  it('is a no-op without a charger (apps without AppThrottlerModule)', async () => {
    const plugin = new OperationRateLimitPlugin(
      { schema } as unknown as GraphQLSchemaHost,
      throttleConfig.parse({}),
      undefined,
    );
    await expect(run(plugin, '{ a }', { req: {} })).resolves.toBeInstanceOf(Map);
  });
});

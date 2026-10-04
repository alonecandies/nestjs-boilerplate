import type { IncomingMessage } from 'node:http';
import type { AuthUser } from '@app/auth';
import { isUuidV7 } from '@app/common';
import DataLoader from 'dataloader';
import { describe, expect, it } from 'vitest';
import { DataLoaderRegistry } from '../loaders/data-loader.registry.js';
import type { GqlRequest, GqlWsConnectionContext } from './gql-context.js';
import { isWsContext } from './gql-context.js';
import { buildWsRequest, createGraphqlContext } from './graphql-context.factory.js';

function upgradeRequest(headers: Record<string, string>): IncomingMessage {
  return {
    headers,
    url: '/graphql',
    socket: { remoteAddress: '10.0.0.7' },
  } as unknown as IncomingMessage;
}

const authUser = { id: 'u1', email: 'jane@example.com' } as AuthUser;

describe('isWsContext', () => {
  it('distinguishes graphql-ws contexts from Fastify requests', () => {
    expect(isWsContext({ connectionParams: {}, extra: {} })).toBe(true);
    // graphql-ws leaves connectionParams unset when the client sent no payload (anonymous).
    expect(isWsContext({ connectionInitReceived: true, extra: {} })).toBe(true);
    expect(isWsContext({ headers: {}, id: 'r1' })).toBe(false);
    expect(isWsContext({ headers: {}, extra: {} })).toBe(false);
    expect(isWsContext({ extra: 'x' })).toBe(false);
    expect(isWsContext(null)).toBe(false);
  });
});

describe('buildWsRequest', () => {
  it('turns connection params into a Bearer header and drops browser credentials', () => {
    const ctx: GqlWsConnectionContext = {
      connectionParams: { authorization: 'Bearer jwt-1' },
      extra: {
        user: authUser,
        request: upgradeRequest({
          cookie: 'session=secret',
          authorization: 'Basic c3B5',
          'user-agent': 'graphql-ws-client',
          'x-request-id': 'req-abc',
        }),
      },
    };

    const req = buildWsRequest(ctx);

    expect(req).toEqual({
      id: 'req-abc',
      method: 'GET',
      url: '/graphql',
      ip: '10.0.0.7',
      user: authUser,
      headers: {
        'user-agent': 'graphql-ws-client',
        'x-request-id': 'req-abc',
        authorization: 'Bearer jwt-1',
      },
    });
  });

  it('generates a uuidv7 request id when none (or an unsafe one) is supplied', () => {
    const req = buildWsRequest({
      connectionParams: undefined,
      extra: { request: upgradeRequest({ 'x-request-id': 'bad id with spaces\n' }) },
    });

    expect(isUuidV7(req.id)).toBe(true);
    expect(req.headers['authorization']).toBeUndefined();
    expect(req.user).toBeUndefined();
  });
});

describe('createGraphqlContext', () => {
  const registry = new DataLoaderRegistry();
  registry.register('echo', () => new DataLoader<string, string>(async (keys) => [...keys]));
  const context = createGraphqlContext(registry);

  it('HTTP: passes the Fastify request/reply through with fresh loaders', () => {
    const req = { id: 'r1', headers: {} } as GqlRequest;
    const reply = { sent: false };

    const ctx = context(req, reply);

    expect(ctx.req).toBe(req);
    expect(ctx.reply).toBe(reply);
    expect(ctx.loaders['echo']).toBeInstanceOf(DataLoader);
  });

  it('graphql-ws: synthesizes the request per operation', () => {
    const ws: GqlWsConnectionContext = {
      connectionParams: { token: 'jwt-2' },
      extra: { user: authUser, request: upgradeRequest({}) },
    };

    const first = context(ws);
    const second = context(ws);

    expect(first.req.user).toBe(authUser);
    expect(first.req.headers['authorization']).toBe('Bearer jwt-2');
    expect(first.reply).toBeUndefined();
    expect(first.loaders['echo']).not.toBe(second.loaders['echo']);
  });
});

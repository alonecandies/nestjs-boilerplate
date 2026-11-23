import { generateId, getHeaderValue, HTTP_HEADERS, isSafeRequestId } from '@platform/common';
import type { ClientIpResolver } from '@platform/redis';
import { omit } from 'lodash-es';
import { extractConnectionToken } from '../auth/subscription-auth.js';
import type { DataLoaderRegistry } from '../loaders/data-loader.registry.js';
import {
  type GqlContext,
  type GqlRequest,
  type GqlWsConnectionContext,
  type GqlWsExtra,
  isWsContext,
} from './gql-context.js';

/** The abort reason of a graphql-ws connection's signal: its socket closed. */
export class GraphqlWsConnectionClosedError extends Error {
  constructor() {
    super('The graphql-ws connection closed');
    this.name = 'GraphqlWsConnectionClosedError';
  }
}

/** One `AbortController` per graphql-ws connection, opened at `onConnect`, aborted at `onClose`. */
export interface GraphqlWsConnectionSignals {
  /** At `onConnect`: the connection gets its controller (once). */
  open(ctx: GqlWsConnectionContext): void;
  /** At `onClose`: aborts the connection's signal (`GraphqlWsConnectionClosedError`). */
  close(ctx: GqlWsConnectionContext): void;
  /** The connection's signal; `undefined` for a connection never opened here. */
  signalOf(ctx: GqlWsConnectionContext): AbortSignal | undefined;
}

/**
 * The per-connection signals, keyed by the connection's `extra` (weakly, so a closed connection
 * holds nothing). One listener-free controller per connection, not one per operation.
 */
export function createGraphqlWsConnectionSignals(): GraphqlWsConnectionSignals {
  const controllers = new WeakMap<GqlWsExtra, AbortController>();
  return {
    open(ctx) {
      if (!controllers.has(ctx.extra)) controllers.set(ctx.extra, new AbortController());
    },
    close(ctx) {
      controllers.get(ctx.extra)?.abort(new GraphqlWsConnectionClosedError());
    },
    signalOf: (ctx) => controllers.get(ctx.extra)?.signal,
  };
}

/**
 * The `GqlRequest` for one graphql-ws operation. It is derived from the upgrade request (headers,
 * IP, URL) and the connection params. The token is exposed as a normal `authorization` header, so
 * the HTTP `JwtAuthGuard` works on subscriptions unchanged. Credentials the browser attached to the
 * upgrade (cookies) are dropped: subscriptions authenticate via connection params only.
 */
export function buildWsRequest(
  ctx: GqlWsConnectionContext,
  clientIp: ClientIpResolver = (request) => request?.socket?.remoteAddress,
): GqlRequest {
  const upgrade = ctx.extra.request;
  const headers: GqlRequest['headers'] = omit(upgrade?.headers ?? {}, ['cookie', 'authorization']);
  const token = extractConnectionToken(ctx.connectionParams);
  if (token !== undefined) headers['authorization'] = `Bearer ${token}`;

  const incomingId = getHeaderValue(headers, HTTP_HEADERS.REQUEST_ID);
  const req: GqlRequest = {
    id: isSafeRequestId(incomingId) ? incomingId : generateId(),
    headers,
    method: 'GET',
  };
  if (ctx.extra.user !== undefined) req.user = ctx.extra.user;
  if (upgrade?.url !== undefined) req.url = upgrade.url;
  const ip = clientIp(upgrade);
  if (ip !== undefined) req.ip = ip;
  return req;
}

/**
 * The Apollo `context` function. It is called with `(request, reply)` for HTTP (Fastify
 * integration) and with `(ctx, message, args)` for each graphql-ws operation. Every call gets
 * fresh DataLoaders. A graphql-ws operation also gets its connection's signal from `connections`.
 */
export function createGraphqlContext(
  registry: DataLoaderRegistry,
  clientIp?: ClientIpResolver,
  connections?: GraphqlWsConnectionSignals,
): (requestOrWsContext: unknown, reply?: unknown) => GqlContext {
  return (requestOrWsContext, reply) => {
    const loaders = registry.createLoaders();
    if (isWsContext(requestOrWsContext)) {
      const context: GqlContext = { req: buildWsRequest(requestOrWsContext, clientIp), loaders };
      const connectionSignal = connections?.signalOf(requestOrWsContext);
      if (connectionSignal !== undefined) context.connectionSignal = connectionSignal;
      return context;
    }
    return { req: requestOrWsContext as GqlRequest, reply, loaders };
  };
}

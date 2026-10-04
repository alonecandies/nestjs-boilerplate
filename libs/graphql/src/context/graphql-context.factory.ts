import { generateId, getHeaderValue, HTTP_HEADERS, isSafeRequestId } from '@app/common';
import { omit } from 'lodash-es';
import { extractConnectionToken } from '../auth/subscription-auth.js';
import type { DataLoaderRegistry } from '../loaders/data-loader.registry.js';
import {
  type GqlContext,
  type GqlRequest,
  type GqlWsConnectionContext,
  isWsContext,
} from './gql-context.js';

/**
 * The `GqlRequest` for one graphql-ws operation. It is derived from the upgrade request (headers,
 * IP, URL) and the connection params. The token is exposed as a normal `authorization` header, so
 * the HTTP `JwtAuthGuard` works on subscriptions unchanged. Credentials the browser attached to the
 * upgrade (cookies) are dropped: subscriptions authenticate via connection params only.
 */
export function buildWsRequest(ctx: GqlWsConnectionContext): GqlRequest {
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
  const ip = upgrade?.socket.remoteAddress;
  if (ip !== undefined) req.ip = ip;
  return req;
}

/**
 * The Apollo `context` function. It is called with `(request, reply)` for HTTP (Fastify
 * integration) and with `(ctx, message, args)` for each graphql-ws operation. Every call gets
 * fresh DataLoaders.
 */
export function createGraphqlContext(
  registry: DataLoaderRegistry,
): (requestOrWsContext: unknown, reply?: unknown) => GqlContext {
  return (requestOrWsContext, reply) => {
    const loaders = registry.createLoaders();
    if (isWsContext(requestOrWsContext)) {
      return { req: buildWsRequest(requestOrWsContext), loaders };
    }
    return { req: requestOrWsContext as GqlRequest, reply, loaders };
  };
}

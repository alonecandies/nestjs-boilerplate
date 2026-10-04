import type { IncomingMessage } from 'node:http';
import type { AuthUser } from '@app/auth';
import type { RequestLike } from '@app/common';
import type { ExecutionContext } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import type DataLoader from 'dataloader';

/**
 * Per-operation DataLoaders by registered name. It is an interface so domain libs can type their
 * loaders through declaration merging:
 * ```ts
 * declare module '@app/graphql' {
 *   interface GraphqlLoaders { users: DataLoader<string, User | null> }
 * }
 * ```
 */
export interface GraphqlLoaders {
  readonly [name: string]: DataLoader<unknown, unknown>;
}

/**
 * The request as resolvers, guards and `@CurrentUser()` see it. Over HTTP it is the Fastify
 * request. For graphql-ws subscriptions it is built from the upgrade request and the
 * connection params, so guards can treat both transports the same way.
 */
export interface GqlRequest extends RequestLike {
  user?: AuthUser;
}

/** What `@Context()` / `GqlExecutionContext.getContext()` return. */
export interface GqlContext {
  req: GqlRequest;
  /** Fastify reply (HTTP operations only). */
  reply?: unknown;
  /** Fresh DataLoaders for this operation: per-request cache, never shared across users. */
  loaders: GraphqlLoaders;
}

/**
 * `ctx.extra` of a graphql-ws connection (Nest uses `graphql-ws/use/ws`). Typed structurally so
 * this package needs no `ws` typings. `user` is set by the `onConnect` authentication.
 */
export interface GqlWsExtra {
  socket?: { close(code?: number, reason?: string): void };
  request?: IncomingMessage;
  user?: AuthUser;
}

/** The graphql-ws connection context (`onConnect`, and the first argument of `context`). */
export interface GqlWsConnectionContext {
  readonly connectionParams?: Readonly<Record<string, unknown>> | undefined;
  readonly extra: GqlWsExtra;
}

/**
 * `true` for the graphql-ws context. Apollo's Fastify integration calls the context function with
 * `(request, reply)`, while graphql-ws calls it with `(ctx, message, args)`. Only graphql-ws
 * contexts carry `extra`, and only requests carry `headers`. `connectionParams` can't serve as the
 * discriminator: graphql-ws sets it only when the client sent an object payload.
 */
export function isWsContext(value: unknown): value is GqlWsConnectionContext {
  if (typeof value !== 'object' || value === null) return false;
  if (!('extra' in value) || 'headers' in value) return false;
  const extra: unknown = value.extra;
  return typeof extra === 'object' && extra !== null;
}

/** Typed `GqlExecutionContext.create(ctx).getContext()` for guards, interceptors and decorators. */
export function getGqlContext(ctx: ExecutionContext): GqlContext {
  return GqlExecutionContext.create(ctx).getContext<GqlContext>();
}

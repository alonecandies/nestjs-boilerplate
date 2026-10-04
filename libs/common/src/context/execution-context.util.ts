import type { ArgumentsHost, ExecutionContext } from '@nestjs/common';

/** Every transport a Nest handler can run under in this platform (`'graphql'` comes from `GqlContextType`). */
export type AppContextType = 'http' | 'graphql' | 'ws' | 'rpc';

/** Transport-neutral view of "the request" that guards, decorators and filters can rely on. */
export interface RequestLike {
  id?: string;
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  user?: unknown;
  url?: string;
  method?: string;
}

/** The parts of a socket.io `Socket` we read (typed structurally → no socket.io dependency). */
interface SocketLike {
  id?: string;
  handshake?: {
    headers?: Record<string, string | string[] | undefined>;
    address?: string;
    url?: string;
  };
  data?: { user?: unknown } | null;
}

/**
 * Returns the transport of the current handler. Typed wrapper over `getType()` that knows about
 * `'graphql'` without importing `@nestjs/graphql`. Global enhancers MUST branch on it because
 * hybrid apps (`inheritAppConfig: true`) run them for gRPC/Kafka/WS handlers too.
 */
export function getContextType(ctx: ExecutionContext | ArgumentsHost): AppContextType {
  return ctx.getType<AppContextType>();
}

/**
 * Socket-derived request views are cached per socket: handshake headers are immutable for the
 * connection's lifetime and guards/decorators ask several times per message.
 */
const wsRequestCache = new WeakMap<object, RequestLike>();

function wsRequest(client: SocketLike): RequestLike {
  const cached = wsRequestCache.get(client);
  if (cached) return cached;
  const request: RequestLike = {
    headers: client.handshake?.headers ?? {},
    // `user` is a live accessor onto `socket.data.user` (set at handshake by the WS auth helper),
    // so a guard assigning `req.user` is visible to later handlers of the same socket.
    get user(): unknown {
      return client.data?.user;
    },
    set user(value: unknown) {
      if (client.data) client.data.user = value;
      else client.data = { user: value };
    },
  };
  if (client.id !== undefined) request.id = client.id;
  if (client.handshake?.address !== undefined) request.ip = client.handshake.address;
  if (client.handshake?.url !== undefined) request.url = client.handshake.url;
  wsRequestCache.set(client, request);
  return request;
}

/**
 * Resolves the platform request for any transport:
 * - http    → `switchToHttp().getRequest()` (FastifyRequest)
 * - graphql → `context.req` (3rd resolver argument; synthesized from connection params for subscriptions)
 * - ws      → a `RequestLike` built from the socket handshake, `user` bound to `socket.data.user`
 * - rpc     → `undefined` (gRPC metadata / Kafka context have no request object)
 */
export function getRequest<T = RequestLike>(ctx: ExecutionContext | ArgumentsHost): T | undefined {
  switch (getContextType(ctx)) {
    case 'http':
      return ctx.switchToHttp().getRequest<T>();
    case 'graphql':
      return ctx.getArgByIndex<{ req?: T } | undefined>(2)?.req;
    case 'ws': {
      const client = ctx.switchToWs().getClient<SocketLike | undefined>();
      return client ? (wsRequest(client) as T) : undefined;
    }
    case 'rpc':
      return undefined;
  }
}

/** First value of a (possibly repeated) header, `undefined` when absent or empty. */
export function getHeaderValue(
  headers: Readonly<Record<string, string | string[] | undefined>> | undefined,
  name: string,
): string | undefined {
  const raw = headers?.[name.toLowerCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === undefined || value === '' ? undefined : value;
}

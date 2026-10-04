import type { IncomingHttpHeaders } from 'node:http';
import {
  type AppContextType,
  generateId,
  getRequest,
  HTTP_HEADERS,
  isSafeRequestId,
  type RequestLike,
} from '@app/common';
import type { ArgumentsHost, ExecutionContext } from '@nestjs/common';
import { head, isObjectLike, isString } from 'lodash-es';

/** Anything with Node-style (lower-cased) headers: `IncomingMessage`, `FastifyRequest`, … */
export interface RequestIdCarrier {
  headers: IncomingHttpHeaders;
}

/**
 * THE request id for an HTTP request. Fastify's `genReqId`, pino-http's `genReqId` and nestjs-cls'
 * `idGenerator` all call it, so `request.id`, the log field `requestId` and `cls.getId()` agree:
 * whichever runs first adopts a valid incoming `x-request-id` (≤128 chars of `[A-Za-z0-9._:-]`) or
 * mints a UUIDv7, and WRITES IT BACK onto the headers so the later callers converge on it. Invalid
 * incoming values are replaced, never echoed (log/header injection, unbounded cardinality).
 */
export function resolveRequestId(req: RequestIdCarrier): string {
  const incoming = req.headers[HTTP_HEADERS.REQUEST_ID];
  if (isSafeRequestId(incoming)) return incoming;
  const id = generateId();
  req.headers[HTTP_HEADERS.REQUEST_ID] = id;
  return id;
}

/**
 * Fast path for callers that run after Fastify's `genReqId` (middie copies `request.id` onto the raw
 * request): reuse that id, else fall back to `resolveRequestId`.
 */
export function requestIdOf(req: RequestIdCarrier & { id?: unknown }): string {
  return isSafeRequestId(req.id) ? req.id : resolveRequestId(req);
}

/** Correlation id of the call chain: a valid incoming `x-correlation-id`, else `undefined`. */
export function incomingCorrelationId(req: RequestIdCarrier): string | undefined {
  const incoming = req.headers[HTTP_HEADERS.CORRELATION_ID];
  return isSafeRequestId(incoming) ? incoming : undefined;
}

type MethodHost<K extends string> = Record<K, (...args: unknown[]) => unknown>;

const hasMethod = <K extends string>(value: object, key: K): value is MethodHost<K> =>
  typeof (value as Partial<Record<K, unknown>>)[key] === 'function';

/** First textual value of a transport header (string, Buffer, or a list of either). */
function firstText(value: unknown): string | undefined {
  const first: unknown = Array.isArray(value) ? head(value) : value;
  if (isString(first)) return first;
  return Buffer.isBuffer(first) ? first.toString('utf8') : undefined;
}

/**
 * Reads a header from the RPC context structurally, so this package needs neither
 * `@nestjs/microservices` nor `@grpc/grpc-js`:
 * - Kafka → `KafkaContext#getMessage().headers[name]`
 * - gRPC  → `Metadata#get(name)` (the rpc "context" of a gRPC handler IS its Metadata)
 */
function readRpcHeader(rpcContext: object, name: string): string | undefined {
  if (hasMethod(rpcContext, 'getMessage')) {
    const message: unknown = rpcContext.getMessage();
    if (!isObjectLike(message)) return undefined;
    const headers = (message as { headers?: unknown }).headers;
    return isObjectLike(headers)
      ? firstText((headers as Record<string, unknown>)[name])
      : undefined;
  }
  if (hasMethod(rpcContext, 'get')) return firstText(rpcContext.get(name));
  return undefined;
}

/**
 * The nestjs-pino microservice hook and `RequestContextInterceptor` both ask for the id of the same
 * message; caching it on the (per-message) RPC context object makes them agree even when the id
 * had to be generated.
 */
const rpcRequestIds = new WeakMap<object, string>();

/**
 * Request id for a gRPC / Kafka handler: the caller's `x-request-id` (else `x-correlation-id`) from
 * metadata / message headers when valid, else a fresh UUIDv7 — stable per message.
 */
export function resolveRpcRequestId(context: ExecutionContext | ArgumentsHost): string {
  const rpcContext: unknown = context.switchToRpc().getContext();
  if (!isObjectLike(rpcContext)) return generateId();
  const carrier = rpcContext as object;
  const cached = rpcRequestIds.get(carrier);
  if (cached !== undefined) return cached;

  const incoming =
    readRpcHeader(carrier, HTTP_HEADERS.REQUEST_ID) ??
    readRpcHeader(carrier, HTTP_HEADERS.CORRELATION_ID);
  const id = isSafeRequestId(incoming) ? incoming : generateId();
  rpcRequestIds.set(carrier, id);
  return id;
}

/** Request id for ANY transport (used where no HTTP middleware opened a request context). */
export function resolveContextRequestId(context: ExecutionContext): string {
  const type = context.getType<AppContextType>();
  switch (type) {
    case 'rpc':
      return resolveRpcRequestId(context);
    case 'http':
    case 'graphql': {
      const request = getRequest<RequestLike>(context);
      if (isSafeRequestId(request?.id)) return request.id;
      const header = request?.headers[HTTP_HEADERS.REQUEST_ID];
      return isSafeRequestId(header) ? header : generateId();
    }
    case 'ws':
      // One id per message: a socket lives for hours, correlating by socket id would merge them.
      return generateId();
  }
}

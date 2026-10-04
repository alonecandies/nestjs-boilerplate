import { getHeaderValue, HTTP_HEADERS, isSafeRequestId } from '@app/common';
import { CLS_CORRELATION_ID, CLS_USER_ID } from '@app/observability';
import { CLS_REQ, type ClsService } from 'nestjs-cls';

/**
 * nestjs-cls keys written by the transport interceptors (`GrpcContextInterceptor`,
 * `KafkaContextInterceptor`). The request id itself lives in nestjs-cls' own `CLS_ID`, so
 * `cls.getId()` means the same thing for HTTP, gRPC and Kafka handlers.
 *
 * `USER_ID` / `CORRELATION_ID` ARE `@app/observability`'s keys (owner of `ClsModule.forRoot`), so
 * `RequestContextService.userId` / `.correlationId` see what a gRPC call or Kafka message carried,
 * and an HTTP request's validated `x-correlation-id` (stored by the cls middleware) flows into
 * outgoing gRPC metadata and Kafka envelopes — one store, one set of keys.
 */
export const RPC_CLS_KEYS = {
  /** The caller's user id (`string | undefined`). */
  USER_ID: CLS_USER_ID,
  /** Correlation id of the whole call chain (`string`). */
  CORRELATION_ID: CLS_CORRELATION_ID,
  /** The full `IncomingRpcContext` of the current gRPC call (transport-private). */
  CALLER: 'rpcCaller',
} as const;

interface RequestWithHeaders {
  headers: Record<string, string | string[] | undefined>;
}

const hasHeaders = (value: unknown): value is RequestWithHeaders => {
  const headers = (value as { headers?: unknown } | null | undefined)?.headers;
  return typeof headers === 'object' && headers !== null;
};

/**
 * Correlation id of the current operation, in order of preference:
 * 1. the one an RPC interceptor adopted from gRPC metadata / Kafka headers,
 * 2. the HTTP request's `x-correlation-id` (normalised by `CorrelationIdMiddleware`; nestjs-cls
 *    keeps the raw request as `CLS_REQ`),
 * 3. the request id (`cls.getId()`), which starts a new chain.
 * Returns `undefined` outside a CLS context or when nothing safe is available.
 */
export function correlationIdFromCls(cls: ClsService | undefined): string | undefined {
  if (cls === undefined || !cls.isActive()) return undefined;
  const adopted = cls.get<unknown>(RPC_CLS_KEYS.CORRELATION_ID);
  if (isSafeRequestId(adopted)) return adopted;
  const request = cls.get<unknown>(CLS_REQ);
  if (hasHeaders(request)) {
    const header = getHeaderValue(request.headers, HTTP_HEADERS.CORRELATION_ID);
    if (isSafeRequestId(header)) return header;
  }
  const id: unknown = cls.getId();
  return isSafeRequestId(id) ? id : undefined;
}

/** `cls.getId()` when it is a safe request id, else `undefined`. */
export function requestIdFromCls(cls: ClsService | undefined): string | undefined {
  if (cls === undefined || !cls.isActive()) return undefined;
  const id: unknown = cls.getId();
  return isSafeRequestId(id) ? id : undefined;
}

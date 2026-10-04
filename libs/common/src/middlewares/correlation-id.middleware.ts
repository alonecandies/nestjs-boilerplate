import { Injectable, type NestMiddleware } from '@nestjs/common';
import { HTTP_HEADERS } from '../constants/headers.constants.js';
import { getHeaderValue } from '../context/execution-context.util.js';
import { generateId, isSafeRequestId } from '../utils/id.util.js';
import type { NextFunction, RawRequest, RawResponse } from './raw-http.types.js';

/**
 * Guarantees every response carries `x-request-id` (this hop) and `x-correlation-id` (the whole
 * call chain), and normalises both onto the request headers so loggers, nestjs-cls and outgoing
 * gRPC/Kafka metadata read one consistent value.
 *
 * - request id = Fastify `req.id` (already derived from a valid incoming `x-request-id` by the
 *   adapter's `genReqId`), else a valid incoming header, else a fresh UUIDv7.
 * - correlation id = a valid incoming `x-correlation-id`, else the request id.
 * Invalid incoming values are replaced, never echoed (header/log injection).
 */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware<RawRequest, RawResponse> {
  use(req: RawRequest, res: RawResponse, next: NextFunction): void {
    const requestId = resolveRequestId(req);
    const incomingCorrelation = getHeaderValue(req.headers, HTTP_HEADERS.CORRELATION_ID);
    const correlationId = isSafeRequestId(incomingCorrelation) ? incomingCorrelation : requestId;

    req.id ??= requestId;
    req.headers[HTTP_HEADERS.REQUEST_ID] = requestId;
    req.headers[HTTP_HEADERS.CORRELATION_ID] = correlationId;
    // Headers set on the raw response are merged by Fastify's writeHead, so they survive the reply.
    res.setHeader(HTTP_HEADERS.REQUEST_ID, requestId);
    res.setHeader(HTTP_HEADERS.CORRELATION_ID, correlationId);
    next();
  }
}

function resolveRequestId(req: RawRequest): string {
  const platformId = req.id === undefined ? undefined : String(req.id);
  if (isSafeRequestId(platformId)) return platformId;
  const incoming = getHeaderValue(req.headers, HTTP_HEADERS.REQUEST_ID);
  return isSafeRequestId(incoming) ? incoming : generateId();
}

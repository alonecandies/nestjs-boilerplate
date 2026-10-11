import { trace } from '@opentelemetry/api';

/** Span attributes that tie a trace to the ids clients and logs see (`x-request-id`, …). */
export const SPAN_ATTR_REQUEST_ID = 'app.request_id';
export const SPAN_ATTR_CORRELATION_ID = 'app.correlation_id';

/**
 * Tags the active span with the request id (and the correlation id when there is one), so a trace
 * found in Jaeger leads to the logs and problem documents of the same request, and back. A no-op
 * when no tracer is running (`trace.getActiveSpan()` is `undefined`).
 */
export function tagActiveSpan(ids: { requestId: string; correlationId?: string }): void {
  const span = trace.getActiveSpan();
  if (span === undefined) return;
  span.setAttribute(SPAN_ATTR_REQUEST_ID, ids.requestId);
  if (ids.correlationId !== undefined) {
    span.setAttribute(SPAN_ATTR_CORRELATION_ID, ids.correlationId);
  }
}

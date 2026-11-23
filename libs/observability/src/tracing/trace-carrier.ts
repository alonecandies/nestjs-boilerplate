import {
  type Context,
  context,
  createTraceState,
  isSpanContextValid,
  type SpanContext,
  trace,
} from '@opentelemetry/api';

/**
 * A W3C trace context carried in data (an event envelope, a stored row) rather than in transport
 * headers: `traceparent` and, when the span has one, `tracestate`.
 */
export interface TraceCarrier {
  traceparent?: string | undefined;
  tracestate?: string | undefined;
}

const TRACEPARENT_VERSION = '00';
/** `version-traceId-spanId-flags`; version `ff`, an all-zero trace id or span id are invalid. */
const TRACEPARENT =
  /^([\da-f]{2})-((?![0]{32})[\da-f]{32})-((?![0]{16})[\da-f]{16})-([\da-f]{2})(-.*)?$/;

/**
 * The W3C trace context of `ctx` (default: the active context), or `{}` (no keys at all) when it
 * holds no valid span context, e.g. when tracing is off. Written by hand with the API only, so the
 * result does not depend on the propagators the SDK registered (`OTEL_PROPAGATORS`). Never throws.
 */
export function captureTraceCarrier(ctx: Context = context.active()): TraceCarrier {
  const spanContext = trace.getSpanContext(ctx);
  if (spanContext === undefined || !isSpanContextValid(spanContext)) return {};
  const flags = (spanContext.traceFlags & 0xff).toString(16).padStart(2, '0');
  const carrier: TraceCarrier = {
    traceparent: `${TRACEPARENT_VERSION}-${spanContext.traceId}-${spanContext.spanId}-${flags}`,
  };
  const tracestate = spanContext.traceState?.serialize();
  if (tracestate !== undefined && tracestate !== '') carrier.tracestate = tracestate;
  return carrier;
}

/** The remote span context `carrier` describes, or `undefined` when its traceparent is invalid. */
function spanContextOf(carrier: TraceCarrier): SpanContext | undefined {
  const match = TRACEPARENT.exec(carrier.traceparent ?? '');
  if (match === null) return undefined;
  const [, version, traceId, spanId, flags, rest] = match;
  // Version ff is forbidden; version 00 has exactly four fields (later versions may add more).
  if (version === 'ff' || (version === TRACEPARENT_VERSION && rest !== undefined)) return undefined;
  if (traceId === undefined || spanId === undefined || flags === undefined) return undefined;
  return {
    traceId,
    spanId,
    traceFlags: Number.parseInt(flags, 16),
    isRemote: true,
    ...(carrier.tracestate ? { traceState: createTraceState(carrier.tracestate) } : {}),
  };
}

/**
 * Runs `fn` under the trace context `carrier` holds, as the child of a remote parent, so the spans
 * `fn` starts (the kafkajs produce span, …) join that trace. A missing or malformed traceparent
 * runs `fn` under the current context unchanged. Never throws on its own.
 */
export function runWithTraceCarrier<T>(carrier: TraceCarrier, fn: () => T): T {
  const remote = spanContextOf(carrier);
  if (remote === undefined) return fn();
  return context.with(trace.setSpanContext(context.active(), remote), fn);
}

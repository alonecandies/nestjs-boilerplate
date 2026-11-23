import {
  context,
  createTraceState,
  propagation,
  type Span,
  TraceFlags,
  trace,
} from '@opentelemetry/api';
import { node } from '@opentelemetry/sdk-node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { captureTraceCarrier, runWithTraceCarrier } from './trace-carrier.js';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const SPAN_ID = '00f067aa0ba902b7';

describe('trace carrier (W3C traceparent / tracestate)', () => {
  const exporter = new node.InMemorySpanExporter();
  const provider = new node.NodeTracerProvider({
    spanProcessors: [new node.SimpleSpanProcessor(exporter)],
  });
  const tracer = () => trace.getTracer('trace-carrier.spec');

  beforeAll(() => {
    // Registers the AsyncLocalStorage context manager too: without one `context.with` is a no-op.
    provider.register();
  });

  afterEach(() => {
    exporter.reset();
  });

  afterAll(async () => {
    await provider.shutdown();
    trace.disable();
    context.disable();
    propagation.disable();
  });

  it('captures the active span as traceparent (and tracestate when it has one)', () => {
    tracer().startActiveSpan('request', (span: Span) => {
      const { traceId, spanId } = span.spanContext();
      expect(captureTraceCarrier()).toEqual({ traceparent: `00-${traceId}-${spanId}-01` });
      span.end();
    });

    const remote = trace.setSpanContext(context.active(), {
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      traceFlags: TraceFlags.NONE,
      isRemote: true,
      traceState: createTraceState('vendor=opaque'),
    });
    expect(captureTraceCarrier(remote)).toEqual({
      traceparent: `00-${TRACE_ID}-${SPAN_ID}-00`,
      tracestate: 'vendor=opaque',
    });
  });

  it('captures nothing without a valid span context (no keys at all)', () => {
    const carrier = captureTraceCarrier();
    expect(carrier).toEqual({});
    expect(Object.keys(carrier)).toEqual([]);
    const invalid = trace.setSpanContext(context.active(), {
      traceId: '0'.repeat(32),
      spanId: '0'.repeat(16),
      traceFlags: TraceFlags.SAMPLED,
    });
    expect(Object.keys(captureTraceCarrier(invalid))).toEqual([]);
  });

  it('runs a function under the carried context: its spans join the carried trace', () => {
    const carrier = {
      traceparent: `00-${TRACE_ID}-${SPAN_ID}-01`,
      tracestate: 'vendor=opaque,other=1',
    };
    const seen = runWithTraceCarrier(carrier, () => {
      const inner = tracer().startSpan('produce');
      inner.end();
      return captureTraceCarrier();
    });

    const [produce] = exporter.getFinishedSpans();
    expect(produce?.spanContext().traceId).toBe(TRACE_ID);
    expect(produce?.parentSpanContext?.spanId).toBe(SPAN_ID);
    expect(produce?.parentSpanContext?.isRemote).toBe(true);
    expect(seen).toEqual(carrier);
    // Outside the callback the context is what it was.
    expect(trace.getSpanContext(context.active())).toBeUndefined();
  });

  it('round-trips: captured inside a span, replayed later from a context without one', async () => {
    const carrier = tracer().startActiveSpan('request', (span: Span) => {
      span.end();
      return captureTraceCarrier();
    });
    const original = exporter.getFinishedSpans()[0];
    exporter.reset();

    await runWithTraceCarrier(carrier, async () => {
      await Promise.resolve();
      tracer().startSpan('produce').end();
    });

    const [produce] = exporter.getFinishedSpans();
    expect(produce?.spanContext().traceId).toBe(original?.spanContext().traceId);
    expect(produce?.parentSpanContext?.spanId).toBe(original?.spanContext().spanId);
  });

  it.each([
    [{}],
    [{ traceparent: '' }],
    [{ traceparent: 'garbage' }],
    [{ traceparent: `ff-${TRACE_ID}-${SPAN_ID}-01` }],
    [{ traceparent: `00-${'0'.repeat(32)}-${SPAN_ID}-01` }],
    [{ traceparent: `00-${TRACE_ID}-${'0'.repeat(16)}-01` }],
    [{ traceparent: `00-${TRACE_ID}-${SPAN_ID}-01-extra` }],
    [{ traceparent: `00-${TRACE_ID.toUpperCase()}-${SPAN_ID}-01` }],
  ])('runs %j under the ambient context, never throwing', (carrier) => {
    const result = runWithTraceCarrier(carrier, () => {
      tracer().startSpan('produce').end();
      return 'ran';
    });
    expect(result).toBe('ran');
    expect(exporter.getFinishedSpans()[0]?.parentSpanContext).toBeUndefined();
  });

  it('accepts a future traceparent version with extra fields (W3C forward compatibility)', () => {
    runWithTraceCarrier({ traceparent: `01-${TRACE_ID}-${SPAN_ID}-01-extra` }, () => {
      tracer().startSpan('produce').end();
    });
    expect(exporter.getFinishedSpans()[0]?.spanContext().traceId).toBe(TRACE_ID);
  });
});

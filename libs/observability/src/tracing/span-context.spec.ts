import { type Span, trace } from '@opentelemetry/api';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SPAN_ATTR_CORRELATION_ID, SPAN_ATTR_REQUEST_ID, tagActiveSpan } from './span-context.js';

function fakeSpan(): Span & { setAttribute: ReturnType<typeof vi.fn> } {
  return { setAttribute: vi.fn() } as unknown as Span & { setAttribute: ReturnType<typeof vi.fn> };
}

describe('tagActiveSpan', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('puts the request and correlation ids on the active span (logs ↔ traces)', () => {
    const span = fakeSpan();
    vi.spyOn(trace, 'getActiveSpan').mockReturnValue(span);

    tagActiveSpan({ requestId: 'req-1', correlationId: 'corr-9' });

    expect(span.setAttribute).toHaveBeenCalledWith(SPAN_ATTR_REQUEST_ID, 'req-1');
    expect(span.setAttribute).toHaveBeenCalledWith(SPAN_ATTR_CORRELATION_ID, 'corr-9');
    expect([SPAN_ATTR_REQUEST_ID, SPAN_ATTR_CORRELATION_ID]).toEqual([
      'app.request_id',
      'app.correlation_id',
    ]);
  });

  it('skips the correlation id when there is none, and is a no-op without a running tracer', () => {
    const span = fakeSpan();
    vi.spyOn(trace, 'getActiveSpan').mockReturnValueOnce(span).mockReturnValueOnce(undefined);

    tagActiveSpan({ requestId: 'req-2' });
    expect(span.setAttribute).toHaveBeenCalledTimes(1);
    expect(() => tagActiveSpan({ requestId: 'req-3' })).not.toThrow();
  });
});

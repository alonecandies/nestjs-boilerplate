import { generateId } from '@platform/common';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { eventEnvelopeSchema } from './envelope.js';
import { createEventEnvelope, defineEventContract, parseEventEnvelope } from './event-contract.js';

const payload = z.object({ orderId: z.uuid() });
const ORDER_PLACED = defineEventContract('orders.order-placed.v1', payload);
const meta = { id: generateId(), source: 'orders-service' };
const body = { orderId: generateId() };

const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
const TRACESTATE = 'vendor=opaque';

/**
 * The envelope schema of a consumer built before the trace fields existed: a frozen copy of the
 * shape without `traceparent` and `tracestate` (zod's default strips unknown keys).
 */
const OLD_ENVELOPE_SCHEMA = z.object({
  id: z.uuid(),
  type: z.string().min(1),
  version: z.number().int().positive(),
  occurredAt: z.iso.datetime(),
  source: z.string().min(1),
  correlationId: z.string().min(1).optional(),
  tenantId: z.uuid().optional(),
  actorId: z.uuid().nullable().optional(),
  payload,
});

describe('envelope trace context (traceparent, tracestate)', () => {
  it('declares both fields as optional strings and keeps them when present', () => {
    const envelope = createEventEnvelope(ORDER_PLACED, body, {
      ...meta,
      traceparent: TRACEPARENT,
      tracestate: TRACESTATE,
    });
    expect(envelope).toMatchObject({ traceparent: TRACEPARENT, tracestate: TRACESTATE });
    expect(parseEventEnvelope(ORDER_PLACED, envelope)).toMatchObject({
      traceparent: TRACEPARENT,
      tracestate: TRACESTATE,
    });
    expect(eventEnvelopeSchema(payload).shape.traceparent.safeParse(undefined).success).toBe(true);
    expect(eventEnvelopeSchema(payload).shape.tracestate.safeParse(42).success).toBe(false);
  });

  it('without trace meta the envelope has exactly the keys it had before, key for key', () => {
    const envelope = createEventEnvelope(ORDER_PLACED, body, { ...meta, correlationId: 'corr-1' });
    expect(Object.keys(envelope).sort()).toEqual(
      ['id', 'type', 'version', 'occurredAt', 'source', 'correlationId', 'payload'].sort(),
    );
    const traced = createEventEnvelope(ORDER_PLACED, body, {
      ...meta,
      traceparent: TRACEPARENT,
    });
    expect(Object.keys(traced)).not.toContain('tracestate');
  });

  it('mixed versions: an envelope without the fields parses as before', () => {
    const legacy = createEventEnvelope(ORDER_PLACED, body, meta);
    const parsed = parseEventEnvelope(ORDER_PLACED, legacy);
    expect(parsed).toEqual(legacy);
    expect(parsed).not.toHaveProperty('traceparent');
    expect(parsed).not.toHaveProperty('tracestate');
  });

  it('mixed versions: an old consumer parses an envelope with the fields and strips them', () => {
    const envelope = createEventEnvelope(ORDER_PLACED, body, {
      ...meta,
      traceparent: TRACEPARENT,
      tracestate: TRACESTATE,
    });
    const parsed = OLD_ENVELOPE_SCHEMA.parse(envelope);
    expect(parsed).not.toHaveProperty('traceparent');
    expect(parsed).not.toHaveProperty('tracestate');
    expect(parsed.id).toBe(envelope.id);
    expect(parsed.payload).toEqual(body);
  });
});

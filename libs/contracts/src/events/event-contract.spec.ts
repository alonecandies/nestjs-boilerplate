import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import type { EventEnvelope } from './envelope.js';
import {
  createEventEnvelope,
  defineEventContract,
  type EventContract,
  type EventEnvelopeOf,
  type EventPayloadOf,
  eventEnvelopeSchemaFor,
  isEventContract,
  parseEventEnvelope,
  safeParseEventEnvelope,
} from './event-contract.js';

const orderPlacedPayload = z.object({
  orderId: z.uuid(),
  amountTotal: z.number().int().nonnegative(),
  currency: z.string().length(3),
});
type OrderPlacedPayload = z.infer<typeof orderPlacedPayload>;

const ORDER_PLACED_EVENT: EventContract<OrderPlacedPayload> = defineEventContract(
  'orders.order-placed.v1',
  orderPlacedPayload,
);
const ORDER_SHIPPED_EVENT = defineEventContract(
  'orders.order-shipped.v2',
  z.object({ orderId: z.uuid(), carrier: z.string() }),
);

const ORDER_ID = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const EVENT_ID = '0199a1b2-c3d4-7e5f-8a9b-000000000001';
const orderPlaced: OrderPlacedPayload = { orderId: ORDER_ID, amountTotal: 4999, currency: 'usd' };

function envelope(payload: unknown, overrides: Record<string, unknown> = {}) {
  return {
    id: EVENT_ID,
    type: 'orders.order-placed.v1',
    version: 1,
    occurredAt: '2026-09-29T10:00:00.123Z',
    source: 'orders-service',
    correlationId: 'req-1',
    payload,
    ...overrides,
  };
}

describe('defineEventContract', () => {
  it('returns a frozen { topic, payload } pair', () => {
    expect(ORDER_PLACED_EVENT).toEqual({
      topic: 'orders.order-placed.v1',
      payload: orderPlacedPayload,
    });
    expect(Object.isFrozen(ORDER_PLACED_EVENT)).toBe(true);
  });

  it.each([
    'orders.order-placed',
    'orders.order-placed.v0',
    'orders.order-placed.v01',
    'Orders.order-placed.v1',
    'orders.order_placed.v1',
    'orders.order-placed.v1.dlq',
  ])('rejects the malformed topic %s at definition time', (topic) => {
    expect(() => defineEventContract(topic, orderPlacedPayload)).toThrow(
      /<context>\.<event-name>\.v<major>/,
    );
  });

  it('carries the payload and envelope types', () => {
    expectTypeOf<EventPayloadOf<typeof ORDER_PLACED_EVENT>>().toEqualTypeOf<OrderPlacedPayload>();
    expectTypeOf<EventEnvelopeOf<typeof ORDER_PLACED_EVENT>>().toEqualTypeOf<
      EventEnvelope<OrderPlacedPayload>
    >();
    expectTypeOf<EventPayloadOf<typeof ORDER_SHIPPED_EVENT>>().toEqualTypeOf<{
      orderId: string;
      carrier: string;
    }>();
  });
});

describe('isEventContract', () => {
  it('recognises contracts and nothing else', () => {
    expect(isEventContract(ORDER_PLACED_EVENT)).toBe(true);
    expect(isEventContract({ topic: 'orders.order-placed.v1', payload: {} })).toBe(false);
    expect(isEventContract({ topic: 'nope', payload: orderPlacedPayload })).toBe(false);
    expect(isEventContract('orders.order-placed.v1')).toBe(false);
    expect(isEventContract(null)).toBe(false);
  });
});

describe('eventEnvelopeSchemaFor', () => {
  it('builds the envelope schema once per contract', () => {
    const schema = eventEnvelopeSchemaFor(ORDER_PLACED_EVENT);
    expect(eventEnvelopeSchemaFor(ORDER_PLACED_EVENT)).toBe(schema);
    expect(eventEnvelopeSchemaFor(ORDER_SHIPPED_EVENT)).not.toBe(schema);
  });

  it('infers exactly the hand-written EventEnvelope interface', () => {
    type Parsed = z.infer<ReturnType<typeof eventEnvelopeSchemaFor<OrderPlacedPayload>>>;
    expectTypeOf<Parsed>().toEqualTypeOf<EventEnvelope<OrderPlacedPayload>>();
  });
});

describe('parseEventEnvelope', () => {
  it('parses a valid envelope with a typed payload', () => {
    const raw = envelope(orderPlaced);
    const parsed = parseEventEnvelope(ORDER_PLACED_EVENT, raw);
    expect(parsed).toEqual(raw);
    expectTypeOf(parsed.payload).toEqualTypeOf<OrderPlacedPayload>();
  });

  it('strips unknown keys (tolerant reader) instead of rejecting them', () => {
    const raw = envelope({ ...orderPlaced, addedLater: true }, { traceparent: '00-abc' });
    const parsed = parseEventEnvelope(ORDER_PLACED_EVENT, raw);
    expect(parsed).not.toHaveProperty('traceparent');
    expect(parsed.payload).not.toHaveProperty('addedLater');
  });

  it('accepts a missing correlationId', () => {
    const { correlationId: _omit, ...raw } = envelope(orderPlaced);
    expect(parseEventEnvelope(ORDER_PLACED_EVENT, raw).correlationId).toBeUndefined();
  });

  it.each([
    ['non-uuid id', { id: 'not-a-uuid' }, ['id']],
    ['zero version', { version: 0 }, ['version']],
    ['offset datetime', { occurredAt: '2026-09-29T10:00:00+02:00' }, ['occurredAt']],
    ['empty source', { source: '' }, ['source']],
    ['missing payload', { payload: undefined }, ['payload']],
  ])('rejects an envelope with %s', (_label, overrides, path) => {
    const raw = envelope(orderPlaced, overrides);
    expect(() => parseEventEnvelope(ORDER_PLACED_EVENT, raw)).toThrow(z.ZodError);
    const result = safeParseEventEnvelope(ORDER_PLACED_EVENT, raw);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toContainEqual(path);
  });

  it.each([
    ['fractional amount', { ...orderPlaced, amountTotal: 10.5 }, ['payload', 'amountTotal']],
    ['long currency', { ...orderPlaced, currency: 'dollars' }, ['payload', 'currency']],
  ] as const)('rejects a payload with a %s', (_label, payload, path) => {
    const result = safeParseEventEnvelope(ORDER_PLACED_EVENT, envelope(payload));
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toContainEqual([...path]);
  });

  it("rejects another contract's payload", () => {
    const shipped = { orderId: ORDER_ID, carrier: 'ups' };
    expect(safeParseEventEnvelope(ORDER_PLACED_EVENT, envelope(shipped)).success).toBe(false);
  });
});

describe('createEventEnvelope', () => {
  it('stamps type, version and occurredAt from the contract', () => {
    const occurredAt = new Date('2026-09-29T11:22:33.444Z');
    const built = createEventEnvelope(ORDER_PLACED_EVENT, orderPlaced, {
      id: EVENT_ID,
      source: 'orders-service',
      correlationId: 'req-9',
      occurredAt,
    });
    expect(built).toEqual({
      id: EVENT_ID,
      type: 'orders.order-placed.v1',
      version: 1,
      occurredAt: '2026-09-29T11:22:33.444Z',
      source: 'orders-service',
      correlationId: 'req-9',
      payload: orderPlaced,
    });
    // The wire value is plain JSON and survives serialisation unchanged.
    expect(parseEventEnvelope(ORDER_PLACED_EVENT, JSON.parse(JSON.stringify(built)))).toEqual(
      built,
    );
  });

  it('takes the version from the topic suffix', () => {
    const built = createEventEnvelope(
      ORDER_SHIPPED_EVENT,
      { orderId: ORDER_ID, carrier: 'ups' },
      { id: EVENT_ID, source: 'orders-service' },
    );
    expect(built.version).toBe(2);
  });

  it('defaults occurredAt to now and omits an undefined correlationId', () => {
    const before = Date.now();
    const built = createEventEnvelope(ORDER_PLACED_EVENT, orderPlaced, {
      id: EVENT_ID,
      source: 'orders-service',
    });
    expect(Date.parse(built.occurredAt)).toBeGreaterThanOrEqual(before);
    expect(built).not.toHaveProperty('correlationId');
  });

  it('fails fast in the producer for an invalid payload', () => {
    const invalid = { ...orderPlaced, orderId: 'x' };
    expect(() =>
      createEventEnvelope(ORDER_PLACED_EVENT, invalid, { id: EVENT_ID, source: 's' }),
    ).toThrow(z.ZodError);
  });
});

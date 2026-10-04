import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import type { EventEnvelope } from './envelope.js';
import {
  createEventEnvelope,
  EVENT_ENVELOPE_SCHEMAS,
  EVENT_PAYLOAD_SCHEMAS,
  type EventEnvelopeFor,
  type EventPayload,
  parseEventEnvelope,
  safeParseEventEnvelope,
} from './event-registry.js';
import type { UserRegisteredPayload } from './identity.events.js';
import { KAFKA_TOPIC_VALUES, KAFKA_TOPICS, type KafkaTopic } from './topics.js';

const USER_ID = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const EVENT_ID = '0199a1b2-c3d4-7e5f-8a9b-000000000001';

const userRegistered: UserRegisteredPayload = {
  userId: USER_ID,
  email: 'ada@example.com',
  displayName: 'Ada',
  registeredAt: '2026-09-29T10:00:00.000Z',
};

function envelope(topic: KafkaTopic, payload: unknown, overrides: Record<string, unknown> = {}) {
  return {
    id: EVENT_ID,
    type: topic,
    version: 1,
    occurredAt: '2026-09-29T10:00:00.123Z',
    source: 'identity-service',
    correlationId: 'req-1',
    payload,
    ...overrides,
  };
}

describe('EVENT_PAYLOAD_SCHEMAS / EVENT_ENVELOPE_SCHEMAS', () => {
  it('registers a payload and an envelope schema for every topic', () => {
    expect(Object.keys(EVENT_PAYLOAD_SCHEMAS).sort()).toEqual([...KAFKA_TOPIC_VALUES].sort());
    expect(Object.keys(EVENT_ENVELOPE_SCHEMAS).sort()).toEqual([...KAFKA_TOPIC_VALUES].sort());
    expect(Object.isFrozen(EVENT_ENVELOPE_SCHEMAS)).toBe(true);
  });

  it('infers envelope types identical to the hand-written EventEnvelope interface', () => {
    type Parsed<T extends KafkaTopic> = z.infer<(typeof EVENT_ENVELOPE_SCHEMAS)[T]>;
    expectTypeOf<Parsed<'identity.user-registered.v1'>>().toEqualTypeOf<
      EventEnvelopeFor<'identity.user-registered.v1'>
    >();
    expectTypeOf<Parsed<'billing.payment-succeeded.v1'>>().toEqualTypeOf<
      EventEnvelopeFor<'billing.payment-succeeded.v1'>
    >();
    expectTypeOf<Parsed<'notifications.notification-created.v1'>>().toEqualTypeOf<
      EventEnvelopeFor<'notifications.notification-created.v1'>
    >();
    expectTypeOf<EventEnvelopeFor<typeof KAFKA_TOPICS.USER_REGISTERED>>().toEqualTypeOf<
      EventEnvelope<UserRegisteredPayload>
    >();
  });
});

describe('parseEventEnvelope', () => {
  it('parses a valid user-registered event', () => {
    const raw = envelope(KAFKA_TOPICS.USER_REGISTERED, userRegistered);
    const parsed = parseEventEnvelope(KAFKA_TOPICS.USER_REGISTERED, raw);
    expect(parsed).toEqual(raw);
    expectTypeOf(parsed.payload).toEqualTypeOf<EventPayload<'identity.user-registered.v1'>>();
  });

  it('parses a valid payment-succeeded event', () => {
    const payload = {
      paymentId: EVENT_ID,
      userId: USER_ID,
      stripeCheckoutSessionId: 'cs_test_123',
      amountTotal: 4999,
      currency: 'usd',
      paidAt: '2026-09-29T10:00:00Z',
    };
    const parsed = parseEventEnvelope(
      KAFKA_TOPICS.PAYMENT_SUCCEEDED,
      envelope(KAFKA_TOPICS.PAYMENT_SUCCEEDED, payload),
    );
    expect(parsed.payload).toEqual(payload);
  });

  it('parses a valid notification-created event', () => {
    const payload = {
      notificationId: EVENT_ID,
      userId: USER_ID,
      type: 'payment_receipt',
      title: 'Receipt',
      body: 'Thanks!',
      data: { paymentId: EVENT_ID },
      createdAt: '2026-09-29T10:00:00.000Z',
    };
    const parsed = parseEventEnvelope(
      KAFKA_TOPICS.NOTIFICATION_CREATED,
      envelope(KAFKA_TOPICS.NOTIFICATION_CREATED, payload),
    );
    expect(parsed.payload.type).toBe('payment_receipt');
  });

  it('strips unknown keys (tolerant reader) instead of rejecting them', () => {
    const raw = envelope(
      KAFKA_TOPICS.USER_REGISTERED,
      { ...userRegistered, addedLater: true },
      { traceparent: '00-abc' },
    );
    const parsed = parseEventEnvelope(KAFKA_TOPICS.USER_REGISTERED, raw);
    expect(parsed).not.toHaveProperty('traceparent');
    expect(parsed.payload).not.toHaveProperty('addedLater');
  });

  it('accepts a missing correlationId', () => {
    const { correlationId: _omit, ...raw } = envelope(KAFKA_TOPICS.USER_REGISTERED, userRegistered);
    expect(parseEventEnvelope(KAFKA_TOPICS.USER_REGISTERED, raw).correlationId).toBeUndefined();
  });

  it.each([
    ['non-uuid id', { id: 'not-a-uuid' }, ['id']],
    ['zero version', { version: 0 }, ['version']],
    ['offset datetime', { occurredAt: '2026-09-29T10:00:00+02:00' }, ['occurredAt']],
    ['empty source', { source: '' }, ['source']],
    ['missing payload', { payload: undefined }, ['payload']],
  ])('rejects an envelope with %s', (_label, overrides, path) => {
    const raw = envelope(KAFKA_TOPICS.USER_REGISTERED, userRegistered, overrides);
    expect(() => parseEventEnvelope(KAFKA_TOPICS.USER_REGISTERED, raw)).toThrow(z.ZodError);
    const result = safeParseEventEnvelope(KAFKA_TOPICS.USER_REGISTERED, raw);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toContainEqual(path);
  });

  it.each([
    [KAFKA_TOPICS.USER_REGISTERED, { ...userRegistered, email: 'nope' }, ['payload', 'email']],
    [
      KAFKA_TOPICS.PAYMENT_SUCCEEDED,
      {
        paymentId: EVENT_ID,
        userId: USER_ID,
        stripeCheckoutSessionId: 'cs_1',
        amountTotal: 10.5,
        currency: 'usd',
        paidAt: '2026-09-29T10:00:00Z',
      },
      ['payload', 'amountTotal'],
    ],
    [
      KAFKA_TOPICS.PAYMENT_SUCCEEDED,
      {
        paymentId: EVENT_ID,
        userId: USER_ID,
        stripeCheckoutSessionId: 'cs_1',
        amountTotal: 10,
        currency: 'dollars',
        paidAt: '2026-09-29T10:00:00Z',
      },
      ['payload', 'currency'],
    ],
    [
      KAFKA_TOPICS.NOTIFICATION_CREATED,
      {
        notificationId: EVENT_ID,
        userId: USER_ID,
        type: 'marketing',
        title: 't',
        body: 'b',
        data: {},
        createdAt: '2026-09-29T10:00:00Z',
      },
      ['payload', 'type'],
    ],
  ] as const)('rejects an invalid %s payload', (topic, payload, path) => {
    const result = safeParseEventEnvelope(topic, envelope(topic, payload));
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toContainEqual([...path]);
  });

  it('rejects a payload that belongs to another topic', () => {
    const raw = envelope(KAFKA_TOPICS.PAYMENT_SUCCEEDED, userRegistered);
    expect(safeParseEventEnvelope(KAFKA_TOPICS.PAYMENT_SUCCEEDED, raw).success).toBe(false);
  });

  it('throws a plain Error for an unregistered topic', () => {
    const unknownTopic = 'identity.user-deleted.v1' as KafkaTopic;
    expect(() => parseEventEnvelope(unknownTopic, {})).toThrow(/No event schema registered/);
    expect(() => safeParseEventEnvelope(unknownTopic, {})).toThrow(/No event schema registered/);
  });
});

describe('createEventEnvelope', () => {
  it('stamps type, version and occurredAt from the topic', () => {
    const occurredAt = new Date('2026-09-29T11:22:33.444Z');
    const built = createEventEnvelope(KAFKA_TOPICS.USER_REGISTERED, userRegistered, {
      id: EVENT_ID,
      source: 'identity-service',
      correlationId: 'req-9',
      occurredAt,
    });
    expect(built).toEqual({
      id: EVENT_ID,
      type: 'identity.user-registered.v1',
      version: 1,
      occurredAt: '2026-09-29T11:22:33.444Z',
      source: 'identity-service',
      correlationId: 'req-9',
      payload: userRegistered,
    });
    // The wire value is plain JSON and survives serialisation unchanged.
    expect(
      parseEventEnvelope(KAFKA_TOPICS.USER_REGISTERED, JSON.parse(JSON.stringify(built))),
    ).toEqual(built);
  });

  it('defaults occurredAt to now and omits an undefined correlationId', () => {
    const before = Date.now();
    const built = createEventEnvelope(KAFKA_TOPICS.USER_REGISTERED, userRegistered, {
      id: EVENT_ID,
      source: 'identity-service',
    });
    expect(Date.parse(built.occurredAt)).toBeGreaterThanOrEqual(before);
    expect(built).not.toHaveProperty('correlationId');
  });

  it('fails fast in the producer for an invalid payload', () => {
    const invalid = { ...userRegistered, userId: 'x' };
    expect(() =>
      createEventEnvelope(KAFKA_TOPICS.USER_REGISTERED, invalid, { id: EVENT_ID, source: 's' }),
    ).toThrow(z.ZodError);
  });
});

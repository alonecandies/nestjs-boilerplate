import { generateId } from '@app/common';
import { KAFKA_TOPICS, type KafkaTopic } from '@app/contracts';
import { describe, expect, it } from 'vitest';
import { InvalidEventException } from './kafka.errors.js';
import { ParseEventEnvelopePipe } from './parse-event-envelope.pipe.js';

const validEnvelope = (): Record<string, unknown> => ({
  id: generateId(),
  type: KAFKA_TOPICS.PAYMENT_SUCCEEDED,
  version: 1,
  occurredAt: '2026-09-01T10:00:00.000Z',
  source: 'billing-service',
  correlationId: 'corr-1',
  payload: {
    paymentId: generateId(),
    userId: generateId(),
    stripeCheckoutSessionId: 'cs_test_1',
    amountTotal: 1999,
    currency: 'usd',
    paidAt: '2026-09-01T10:00:00.000Z',
  },
});

/** The value `fn` throws; fails the test when it does not throw. */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the function to throw');
}

describe('ParseEventEnvelopePipe', () => {
  const pipe = new ParseEventEnvelopePipe(KAFKA_TOPICS.PAYMENT_SUCCEEDED);

  it('returns the typed envelope and strips unknown keys (tolerant reader)', () => {
    const raw = { ...validEnvelope(), extra: 'ignored' };
    const envelope = pipe.transform(raw);
    expect(envelope.payload.amountTotal).toBe(1999);
    expect(envelope).not.toHaveProperty('extra');
  });

  it('throws InvalidEventException with issues for a schema violation', () => {
    const raw = validEnvelope();
    raw['payload'] = { ...(raw['payload'] as object), amountTotal: -1 };
    const error = thrownBy(() => pipe.transform(raw));
    expect(error).toBeInstanceOf(InvalidEventException);
    expect(error).toMatchObject({
      code: 'INVALID_EVENT',
      details: { topic: KAFKA_TOPICS.PAYMENT_SUCCEEDED },
    });
    expect((error as InvalidEventException).issues).toEqual([
      expect.objectContaining({ path: 'payload.amountTotal' }),
    ]);
  });

  it.each([
    ['a string', 'not json'],
    ['null', null],
    ['a Buffer', Buffer.from('{}')],
  ])('rejects %s', (_label, value) => {
    expect(() => pipe.transform(value)).toThrow(InvalidEventException);
  });

  it('rejects an envelope of another type or version', () => {
    const wrongType = { ...validEnvelope(), type: KAFKA_TOPICS.USER_REGISTERED };
    expect(() => pipe.transform(wrongType)).toThrow(InvalidEventException);
    const error = thrownBy(() => pipe.transform({ ...validEnvelope(), version: 2 }));
    expect(error).toBeInstanceOf(InvalidEventException);
    expect((error as InvalidEventException).issues).toEqual([
      expect.objectContaining({ path: 'version' }),
    ]);
  });

  it('fails fast for an unknown topic', () => {
    expect(() => new ParseEventEnvelopePipe('nope.v1' as KafkaTopic)).toThrow(
      /Unknown Kafka topic/,
    );
  });
});

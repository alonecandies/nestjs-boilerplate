import { generateId } from '@platform/common';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  FIXTURE_ORDER_PLACED_EVENT,
  FIXTURE_USER_REGISTERED_EVENT,
} from '../../test/fixtures/fixture.events.js';
import { InvalidEventException } from './kafka.errors.js';
import { ParseEventEnvelopePipe } from './parse-event-envelope.pipe.js';

const validEnvelope = (): Record<string, unknown> => ({
  id: generateId(),
  type: FIXTURE_ORDER_PLACED_EVENT.topic,
  version: 1,
  occurredAt: '2026-09-01T10:00:00.000Z',
  source: 'fixture-service',
  correlationId: 'corr-1',
  payload: {
    orderId: generateId(),
    userId: generateId(),
    amountTotal: 1999,
    currency: 'usd',
    placedAt: '2026-09-01T10:00:00.000Z',
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
  const pipe = new ParseEventEnvelopePipe(FIXTURE_ORDER_PLACED_EVENT);

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
      details: { topic: FIXTURE_ORDER_PLACED_EVENT.topic },
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
    const wrongType = { ...validEnvelope(), type: FIXTURE_USER_REGISTERED_EVENT.topic };
    expect(() => pipe.transform(wrongType)).toThrow(InvalidEventException);
    const error = thrownBy(() => pipe.transform({ ...validEnvelope(), version: 2 }));
    expect(error).toBeInstanceOf(InvalidEventException);
    expect((error as InvalidEventException).issues).toEqual([
      expect.objectContaining({ path: 'version' }),
    ]);
  });

  it('fails fast for a contract whose topic has no version suffix', () => {
    expect(() => new ParseEventEnvelopePipe({ topic: 'nope', payload: z.object({}) })).toThrow(
      /no "\.v<major>" suffix/,
    );
  });
});

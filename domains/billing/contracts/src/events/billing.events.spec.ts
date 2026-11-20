import { createEventEnvelope, parseEventEnvelope, topicVersion } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  LEDGER_POSTING_REQUESTED_EVENT,
  type LedgerPostingRequestedPayload,
  PAYMENT_SUCCEEDED_EVENT,
  type PaymentSucceededPayload,
} from '../index.js';

const payload: PaymentSucceededPayload = {
  paymentId: '0199a1b2-c3d4-7e5f-8a9b-000000000002',
  userId: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
  stripeCheckoutSessionId: 'cs_test_123',
  amountTotal: 4999,
  currency: 'usd',
  paidAt: '2026-09-29T10:00:00Z',
};

const envelope = (value: unknown) => ({
  id: '0199a1b2-c3d4-7e5f-8a9b-000000000001',
  type: PAYMENT_SUCCEEDED_EVENT.topic,
  version: 1,
  occurredAt: '2026-09-29T10:00:00.123Z',
  source: 'billing-service',
  payload: value,
});

/** The issue paths of the `ZodError` that `parseEventEnvelope` throws for `value` (fails otherwise). */
const rejectedPaths = (value: unknown): PropertyKey[][] => {
  try {
    parseEventEnvelope(PAYMENT_SUCCEEDED_EVENT, envelope(value));
  } catch (error) {
    expect(error).toBeInstanceOf(z.ZodError);
    return (error as z.ZodError).issues.map((issue) => issue.path);
  }
  throw new Error('expected parseEventEnvelope to throw a ZodError');
};

describe('PAYMENT_SUCCEEDED_EVENT', () => {
  it('keeps its wire name (consumer offsets and docker/kafka/topics.txt depend on it)', () => {
    expect(PAYMENT_SUCCEEDED_EVENT.topic).toBe('billing.payment-succeeded.v1');
    expect(topicVersion(PAYMENT_SUCCEEDED_EVENT.topic)).toBe(1);
  });

  it('is tenant-scoped: an envelope is only created with the payment tenant (B2-26)', () => {
    const tenantId = '0199a1b2-c3d4-7e5f-8a9b-000000000009';
    const eventId = '0199a1b2-c3d4-7e5f-8a9b-000000000001';
    expect(PAYMENT_SUCCEEDED_EVENT.tenantScoped).toBe(true);
    expect(() =>
      createEventEnvelope(PAYMENT_SUCCEEDED_EVENT, payload, { id: eventId, source: 'billing' }),
    ).toThrow(/tenantId/);
    expect(
      createEventEnvelope(PAYMENT_SUCCEEDED_EVENT, payload, {
        id: eventId,
        source: 'billing',
        tenantId,
        actorId: payload.userId,
      }),
    ).toMatchObject({ tenantId, actorId: payload.userId });
  });

  it('parses a valid payload', () => {
    expect(parseEventEnvelope(PAYMENT_SUCCEEDED_EVENT, envelope(payload)).payload).toEqual(payload);
  });

  it.each([
    ['a fractional amount', { amountTotal: 10.5 }, 'amountTotal'],
    ['a negative amount', { amountTotal: -1 }, 'amountTotal'],
    ['a currency that is not ISO 4217', { currency: 'dollars' }, 'currency'],
  ])('rejects %s', (_label, change, field) => {
    expect(rejectedPaths({ ...payload, ...change })).toEqual([['payload', field]]);
  });

  it('accepts the PaymentIntent id, which is optional (v1 stays compatible)', () => {
    const withIntent = { ...payload, stripePaymentIntentId: 'pi_123' };
    expect(parseEventEnvelope(PAYMENT_SUCCEEDED_EVENT, envelope(withIntent)).payload).toEqual(
      withIntent,
    );
    expect(parseEventEnvelope(PAYMENT_SUCCEEDED_EVENT, envelope(payload)).payload).toEqual(payload);
  });

  it('rejects an empty PaymentIntent id', () => {
    expect(rejectedPaths({ ...payload, stripePaymentIntentId: '' })).toEqual([
      ['payload', 'stripePaymentIntentId'],
    ]);
  });
});

describe('LEDGER_POSTING_REQUESTED_EVENT (billing.ledger-posting.v1, L-11)', () => {
  const NIL = '00000000-0000-0000-0000-000000000000';
  const posting: LedgerPostingRequestedPayload = {
    source: 'stripe',
    stripeEventId: 'evt_1',
    stripeEventType: 'charge.succeeded',
    objectType: 'charge',
    objectId: 'ch_1',
    tenantId: '0199a1b2-c3d4-7e5f-8a9b-000000000009',
    userId: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
    paymentId: '0199a1b2-c3d4-7e5f-8a9b-000000000002',
    livemode: false,
  };
  const postingEnvelope = (value: unknown) => ({
    id: '0199a1b2-c3d4-5e5f-8a9b-000000000001',
    type: LEDGER_POSTING_REQUESTED_EVENT.topic,
    version: 1,
    occurredAt: '2026-09-29T10:00:00.123Z',
    source: 'billing-service',
    tenantId: posting.tenantId,
    payload: value,
  });
  const parse = (value: unknown) =>
    parseEventEnvelope(LEDGER_POSTING_REQUESTED_EVENT, postingEnvelope(value)).payload;

  it('keeps its wire name', () => {
    expect(LEDGER_POSTING_REQUESTED_EVENT.topic).toBe('billing.ledger-posting.v1');
    expect(topicVersion(LEDGER_POSTING_REQUESTED_EVENT.topic)).toBe(1);
  });

  it('is tenant-scoped: an envelope is only created with a tenant', () => {
    expect(LEDGER_POSTING_REQUESTED_EVENT.tenantScoped).toBe(true);
    const meta = { id: '0199a1b2-c3d4-5e5f-8a9b-000000000001', source: 'billing' };
    expect(() => createEventEnvelope(LEDGER_POSTING_REQUESTED_EVENT, posting, meta)).toThrow(
      /tenantId/,
    );
    expect(
      createEventEnvelope(LEDGER_POSTING_REQUESTED_EVENT, posting, {
        ...meta,
        tenantId: posting.tenantId,
        actorId: posting.userId,
      }),
    ).toMatchObject({ tenantId: posting.tenantId, actorId: posting.userId });
  });

  it('parses a tenant posting', () => {
    expect(parse(posting)).toEqual(posting);
  });

  it('accepts the nil (platform) tenant with a null user and a null payment', () => {
    const platform = {
      ...posting,
      stripeEventType: 'payout.paid',
      objectType: 'payout',
      objectId: 'po_1',
      tenantId: NIL,
      userId: null,
      paymentId: null,
    };
    expect(parse(platform)).toEqual(platform);
    expect(
      createEventEnvelope(LEDGER_POSTING_REQUESTED_EVENT, platform as never, {
        id: '0199a1b2-c3d4-5e5f-8a9b-000000000001',
        source: 'billing',
        tenantId: NIL,
        actorId: null,
      }),
    ).toMatchObject({ tenantId: NIL, actorId: null });
  });

  it.each(['charge', 'refund', 'dispute', 'payout', 'balance_transaction'] as const)(
    'accepts the object type %s',
    (objectType) => {
      expect(parse({ ...posting, objectType })).toMatchObject({ objectType });
    },
  );

  it.each([
    ['an unknown objectType', { objectType: 'invoice' }, 'objectType'],
    ['another source', { source: 'paypal' }, 'source'],
    ['a tenant that is not a uuid', { tenantId: 'tenant-a' }, 'tenantId'],
    ['a user that is not a uuid', { userId: 'u_1' }, 'userId'],
    ['a payment that is not a uuid', { paymentId: 'pay_1' }, 'paymentId'],
    ['an empty Stripe event id', { stripeEventId: '' }, 'stripeEventId'],
    ['an empty object id', { objectId: '' }, 'objectId'],
    ['a livemode that is not a boolean', { livemode: 'false' }, 'livemode'],
  ])('rejects %s', (_label, change, field) => {
    const error = (() => {
      try {
        parse({ ...posting, ...change });
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(z.ZodError);
    expect((error as z.ZodError).issues.map((issue) => issue.path)).toEqual([['payload', field]]);
  });

  it('requires every field (userId and paymentId are nullable, not optional)', () => {
    const { userId: _user, paymentId: _payment, ...partial } = posting;
    expect(() => parse(partial)).toThrow(z.ZodError);
  });
});

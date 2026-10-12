import { parseEventEnvelope, topicVersion } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { PAYMENT_SUCCEEDED_EVENT, type PaymentSucceededPayload } from '../index.js';

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

describe('PAYMENT_SUCCEEDED_EVENT', () => {
  it('keeps its wire name (consumer offsets and docker/kafka/topics.txt depend on it)', () => {
    expect(PAYMENT_SUCCEEDED_EVENT.topic).toBe('billing.payment-succeeded.v1');
    expect(topicVersion(PAYMENT_SUCCEEDED_EVENT.topic)).toBe(1);
  });

  it('parses a valid payload', () => {
    expect(parseEventEnvelope(PAYMENT_SUCCEEDED_EVENT, envelope(payload)).payload).toEqual(payload);
  });

  it.each([
    ['a fractional amount', { amountTotal: 10.5 }],
    ['a negative amount', { amountTotal: -1 }],
    ['a currency that is not ISO 4217', { currency: 'dollars' }],
  ])('rejects %s', (_label, change) => {
    expect(() =>
      parseEventEnvelope(PAYMENT_SUCCEEDED_EVENT, envelope({ ...payload, ...change })),
    ).toThrow();
  });
});

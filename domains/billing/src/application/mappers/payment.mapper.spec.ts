import { PAYMENT_SUCCEEDED_EVENT } from '@domain/billing-contracts';
import { TEST_TENANT_ID } from '@platform/auth/testing';
import { generateId } from '@platform/common';
import { describe, expect, it } from 'vitest';
import { makePayment } from '../../../test/billing-test.utils.js';
import { PaymentSucceededEvent } from '../../domain/events/payment-succeeded.event.js';
import { PaymentStatus } from '../../domain/payment-status.enum.js';
import {
  toPaymentContract,
  toPaymentListContract,
  toPaymentSucceededPayload,
} from './payment.mapper.js';

describe('payment mapper (aggregate → billing.v1.Payment)', () => {
  it('maps every field, int64 amount as a decimal string', () => {
    const payment = makePayment({
      amountTotal: 12_345,
      currency: 'usd',
      stripeCheckoutSessionId: 'cs_1',
      status: PaymentStatus.Succeeded,
    });
    const s = payment.toSnapshot();

    expect(toPaymentContract(payment)).toEqual({
      id: s.id,
      tenantId: s.tenantId,
      userId: s.userId,
      status: 'succeeded',
      amountTotal: '12345',
      currency: 'usd',
      priceId: s.priceId,
      quantity: s.quantity,
      stripeCheckoutSessionId: 'cs_1',
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    });
  });

  it('reports an unpriced payment as 0 / empty currency and omits the missing session', () => {
    const contract = toPaymentContract(makePayment());

    expect(contract).toMatchObject({ amountTotal: '0', currency: '', status: 'pending' });
    expect(contract).not.toHaveProperty('stripeCheckoutSessionId');
  });

  it('maps pages in order, carrying nextCursor and omitting it on the last page', () => {
    const [a, b] = [makePayment(), makePayment()];

    const page = toPaymentListContract({ items: [a, b], nextCursor: 'next-1' });
    expect(page.items.map((p) => p.id)).toEqual([a.id, b.id]);
    expect(page.nextCursor).toBe('next-1');

    expect(toPaymentListContract({ items: [a], nextCursor: null })).not.toHaveProperty(
      'nextCursor',
    );
  });
});

describe('toPaymentSucceededPayload (domain event → billing.payment-succeeded.v1 payload)', () => {
  const build = (paymentIntentId: string | null) =>
    new PaymentSucceededEvent(
      generateId(),
      generateId(),
      generateId(),
      'cs_test_1',
      2_500,
      'usd',
      new Date('2026-09-04T08:30:00.000Z'),
      paymentIntentId,
      TEST_TENANT_ID,
    );

  it('maps every field the contract carries, paidAt as ISO 8601, and the contract accepts it', () => {
    const event = build(null);
    const payload = toPaymentSucceededPayload(event);
    expect(payload).toEqual({
      paymentId: event.paymentId,
      userId: event.userId,
      stripeCheckoutSessionId: 'cs_test_1',
      amountTotal: 2_500,
      currency: 'usd',
      paidAt: '2026-09-04T08:30:00.000Z',
    });
    expect(PAYMENT_SUCCEEDED_EVENT.payload.parse(payload)).toEqual(payload);
  });

  it('includes stripePaymentIntentId when the event carries it', () => {
    expect(toPaymentSucceededPayload(build('pi_1'))).toMatchObject({
      stripePaymentIntentId: 'pi_1',
    });
  });

  it('omits the key when the event has none', () => {
    expect(toPaymentSucceededPayload(build(null))).not.toHaveProperty('stripePaymentIntentId');
  });
});

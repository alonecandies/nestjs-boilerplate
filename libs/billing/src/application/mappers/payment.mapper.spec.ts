import { describe, expect, it } from 'vitest';
import { makePayment } from '../../../test/billing-test.utils.js';
import { PaymentStatus } from '../../domain/payment-status.enum.js';
import { toPaymentContract, toPaymentListContract } from './payment.mapper.js';

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

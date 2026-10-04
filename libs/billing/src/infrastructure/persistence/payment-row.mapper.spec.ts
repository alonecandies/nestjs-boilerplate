import { describe, expect, it } from 'vitest';
import { makePayment } from '../../../test/billing-test.utils.js';
import { PaymentStatus } from '../../domain/payment-status.enum.js';
import { fromPaymentRow, toPaymentRow } from './payment-row.mapper.js';

describe('payment row mapper', () => {
  it('round-trips every column', () => {
    const payment = makePayment({
      amountTotal: 700,
      currency: 'gbp',
      status: PaymentStatus.Succeeded,
      stripeCheckoutSessionId: 'cs_1',
      stripePaymentIntentId: 'pi_1',
      idempotencyKey: 'key-12345',
      paidAt: new Date('2026-09-03T00:00:00.000Z'),
      version: 3,
    });

    const row = toPaymentRow(payment);
    const restored = fromPaymentRow({
      ...row,
      amountTotal: row.amountTotal ?? null,
      currency: row.currency ?? null,
      status: row.status ?? PaymentStatus.Pending,
      stripeCheckoutSessionId: row.stripeCheckoutSessionId ?? null,
      stripePaymentIntentId: row.stripePaymentIntentId ?? null,
      idempotencyKey: row.idempotencyKey ?? null,
      paidAt: row.paidAt ?? null,
      version: row.version ?? 0,
      createdAt: row.createdAt ?? new Date(0),
      updatedAt: row.updatedAt ?? new Date(0),
    });

    expect(restored.toSnapshot()).toEqual(payment.toSnapshot());
    expect(restored.getUncommittedEvents()).toEqual([]);
  });
});

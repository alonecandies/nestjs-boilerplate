import { Payment } from '../../domain/payment.aggregate.js';
import type { NewPaymentRow, PaymentRow } from './billing.schema.js';

/** Aggregate → insertable row (every column explicit: the aggregate owns ids and timestamps). */
export function toPaymentRow(payment: Payment): NewPaymentRow & { id: string } {
  const s = payment.toSnapshot();
  return {
    tenantId: s.tenantId,
    id: s.id,
    userId: s.userId,
    priceId: s.priceId,
    quantity: s.quantity,
    amountTotal: s.amountTotal,
    currency: s.currency,
    amountRefunded: s.amountRefunded,
    status: s.status,
    stripeCheckoutSessionId: s.stripeCheckoutSessionId,
    stripePaymentIntentId: s.stripePaymentIntentId,
    idempotencyKey: s.idempotencyKey,
    requestHash: s.requestHash,
    paidAt: s.paidAt,
    version: s.version,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

/** Row → aggregate (no events). */
export function fromPaymentRow(row: PaymentRow): Payment {
  return Payment.restore({
    tenantId: row.tenantId,
    id: row.id,
    userId: row.userId,
    priceId: row.priceId,
    quantity: row.quantity,
    amountTotal: row.amountTotal,
    currency: row.currency,
    amountRefunded: row.amountRefunded,
    status: row.status,
    stripeCheckoutSessionId: row.stripeCheckoutSessionId,
    stripePaymentIntentId: row.stripePaymentIntentId,
    idempotencyKey: row.idempotencyKey,
    requestHash: row.requestHash,
    paidAt: row.paidAt,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

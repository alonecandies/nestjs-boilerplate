import type {
  Payment as PaymentContract,
  PaymentList,
  PaymentSucceededPayload,
} from '@domain/billing-contracts';
import type { CursorPage } from '@platform/common';
import type { PaymentSucceededEvent } from '../../domain/events/payment-succeeded.event.js';
import type { Payment } from '../../domain/payment.aggregate.js';

/**
 * Aggregate → `billing.v1.Payment` contract, the shape every port adapter returns. `amountTotal`
 * is an int64 decimal string on the wire (ts-proto `forceLong=string`); an unpriced payment
 * reports `"0"` and an empty currency.
 */
export function toPaymentContract(payment: Payment): PaymentContract {
  const s = payment.toSnapshot();
  return {
    id: s.id,
    tenantId: s.tenantId,
    userId: s.userId,
    status: s.status,
    amountTotal: String(s.amountTotal ?? 0),
    currency: s.currency ?? '',
    priceId: s.priceId,
    quantity: s.quantity,
    ...(s.stripeCheckoutSessionId === null
      ? {}
      : { stripeCheckoutSessionId: s.stripeCheckoutSessionId }),
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

/** A page → `billing.v1.PaymentList`; `nextCursor` is omitted (proto `optional`) on the last page. */
export function toPaymentListContract(page: CursorPage<Payment>): PaymentList {
  return {
    items: page.items.map(toPaymentContract),
    ...(page.nextCursor === null ? {} : { nextCursor: page.nextCursor }),
  };
}

/**
 * Domain event → the `billing.payment-succeeded.v1` payload (`paidAt` as ISO 8601;
 * `stripePaymentIntentId` only when Stripe reported one). The webhook enqueues it on billing's
 * outbox in the unit of work that completes the payment.
 */
export function toPaymentSucceededPayload(event: PaymentSucceededEvent): PaymentSucceededPayload {
  return {
    paymentId: event.paymentId,
    userId: event.userId,
    stripeCheckoutSessionId: event.stripeCheckoutSessionId,
    amountTotal: event.amountTotal,
    currency: event.currency,
    paidAt: event.paidAt.toISOString(),
    ...(event.stripePaymentIntentId === null
      ? {}
      : { stripePaymentIntentId: event.stripePaymentIntentId }),
  };
}

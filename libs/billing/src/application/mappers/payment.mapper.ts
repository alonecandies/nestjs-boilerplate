import type { Payment as PaymentContract, PaymentList } from '@app/contracts';
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

export function toPaymentListContract(payments: readonly Payment[]): PaymentList {
  return { items: payments.map(toPaymentContract) };
}

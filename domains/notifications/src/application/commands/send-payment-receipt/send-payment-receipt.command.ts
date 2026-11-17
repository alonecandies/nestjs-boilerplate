import type { Notification } from '@domain/notifications-contracts';
import { Command } from '@nestjs/cqrs';

export interface SendPaymentReceiptInput {
  /** The payment's tenant: the envelope tenant of `billing.payment-succeeded.v1`. */
  tenantId: string;
  paymentId: string;
  userId: string;
  /** Minor units (cents). */
  amountTotal: number;
  /** ISO 4217, any case. */
  currency: string;
  paidAt: Date;
}

/**
 * Reaction to billing's `payment-succeeded` event: a receipt notification plus a receipt mail
 * to the user's recipient row in the payment's tenant (when there is one). Idempotent end to end,
 * keyed by the payment id.
 */
export class SendPaymentReceiptCommand extends Command<Notification> {
  constructor(readonly input: SendPaymentReceiptInput) {
    super();
  }
}

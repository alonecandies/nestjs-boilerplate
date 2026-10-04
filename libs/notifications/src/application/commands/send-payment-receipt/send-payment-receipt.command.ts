import type { Notification } from '@app/contracts';
import { Command } from '@nestjs/cqrs';

export interface SendPaymentReceiptInput {
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
 * (when the recipient is known). Idempotent end to end, keyed by the payment id.
 */
export class SendPaymentReceiptCommand extends Command<Notification> {
  constructor(readonly input: SendPaymentReceiptInput) {
    super();
  }
}

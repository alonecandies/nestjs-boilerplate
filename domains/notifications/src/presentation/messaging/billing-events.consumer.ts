import { PAYMENT_SUCCEEDED_EVENT } from '@domain/billing-contracts';
import { CommandBus } from '@nestjs/cqrs';
import { Payload } from '@nestjs/microservices';
import type { EventEnvelopeOf } from '@platform/contracts';
import {
  KafkaConsumerController,
  KafkaEventPattern,
  ParseEventEnvelopePipe,
} from '@platform/transport';
import { SendPaymentReceiptCommand } from '../../application/commands/send-payment-receipt/send-payment-receipt.command.js';
import { requireEventTenant } from './event-tenant.js';

type PaymentSucceededEnvelope = EventEnvelopeOf<typeof PAYMENT_SUCCEEDED_EVENT>;

/**
 * billing → notifications: a receipt notification + receipt mail per succeeded payment.
 * The receipt is mailed to the payer's recipient row in the envelope tenant (the payment's).
 * Dead-lettering and idempotency as in `IdentityEventsConsumer` (keyed by payment id).
 */
@KafkaConsumerController()
export class BillingEventsConsumer {
  constructor(private readonly commandBus: CommandBus) {}

  @KafkaEventPattern(PAYMENT_SUCCEEDED_EVENT)
  async onPaymentSucceeded(
    @Payload(new ParseEventEnvelopePipe(PAYMENT_SUCCEEDED_EVENT))
    event: PaymentSucceededEnvelope,
  ): Promise<void> {
    const tenantId = requireEventTenant(event);
    const { paymentId, userId, amountTotal, currency, paidAt } = event.payload;
    await this.commandBus.execute(
      new SendPaymentReceiptCommand({
        tenantId,
        paymentId,
        userId,
        amountTotal,
        currency,
        paidAt: new Date(paidAt),
      }),
    );
  }
}

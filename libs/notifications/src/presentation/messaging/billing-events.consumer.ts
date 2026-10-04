import { type EventEnvelopeFor, KAFKA_TOPICS } from '@app/contracts';
import { KafkaConsumerController, KafkaEventPattern, ParseEventEnvelopePipe } from '@app/transport';
import { CommandBus } from '@nestjs/cqrs';
import { Payload } from '@nestjs/microservices';
import { SendPaymentReceiptCommand } from '../../application/commands/send-payment-receipt/send-payment-receipt.command.js';

type PaymentSucceededEnvelope = EventEnvelopeFor<typeof KAFKA_TOPICS.PAYMENT_SUCCEEDED>;

/**
 * billing → notifications: a receipt notification + receipt mail per succeeded payment.
 * Dead-lettering and idempotency as in `IdentityEventsConsumer` (keyed by payment id).
 */
@KafkaConsumerController()
export class BillingEventsConsumer {
  constructor(private readonly commandBus: CommandBus) {}

  @KafkaEventPattern(KAFKA_TOPICS.PAYMENT_SUCCEEDED)
  async onPaymentSucceeded(
    @Payload(new ParseEventEnvelopePipe(KAFKA_TOPICS.PAYMENT_SUCCEEDED))
    event: PaymentSucceededEnvelope,
  ): Promise<void> {
    const { paymentId, userId, amountTotal, currency, paidAt } = event.payload;
    await this.commandBus.execute(
      new SendPaymentReceiptCommand({
        paymentId,
        userId,
        amountTotal,
        currency,
        paidAt: new Date(paidAt),
      }),
    );
  }
}

import { KAFKA_TOPICS, type PaymentSucceededPayload } from '@app/contracts';
import { KafkaProducer } from '@app/transport';
import { Logger } from '@nestjs/common';
import { EventsHandler, type IEventHandler } from '@nestjs/cqrs';
import { PaymentSucceededEvent } from '../../domain/events/payment-succeeded.event.js';

export function toPaymentSucceededPayload(event: PaymentSucceededEvent): PaymentSucceededPayload {
  return {
    paymentId: event.paymentId,
    userId: event.userId,
    stripeCheckoutSessionId: event.stripeCheckoutSessionId,
    amountTotal: event.amountTotal,
    currency: event.currency,
    paidAt: event.paidAt.toISOString(),
  };
}

/**
 * Domain → integration event: `PaymentSucceededEvent` → Kafka `billing.payment-succeeded.v1`
 * (keyed by user id, so one user's events stay ordered; envelope id = the domain event id, so a
 * re-publish is deduplicated by consumers).
 *
 * Errors are logged, never thrown: event handlers run detached from the webhook request, and an
 * exception here would only reach the CQRS UnhandledExceptionBus. The payment is already committed
 * at this point; guaranteed delivery needs a transactional outbox (a `billing_outbox` row written
 * in the webhook transaction + a relay polling it) — see README "Consistency".
 */
@EventsHandler(PaymentSucceededEvent)
export class PaymentSucceededRelay implements IEventHandler<PaymentSucceededEvent> {
  private readonly logger = new Logger(PaymentSucceededRelay.name);

  constructor(private readonly kafka: KafkaProducer) {}

  async handle(event: PaymentSucceededEvent): Promise<void> {
    try {
      await this.kafka.publish(KAFKA_TOPICS.PAYMENT_SUCCEEDED, toPaymentSucceededPayload(event), {
        key: event.userId,
        eventId: event.eventId,
        occurredAt: event.paidAt,
      });
    } catch (error) {
      this.logger.error(
        `Failed to publish ${KAFKA_TOPICS.PAYMENT_SUCCEEDED} for payment ${event.paymentId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }
}

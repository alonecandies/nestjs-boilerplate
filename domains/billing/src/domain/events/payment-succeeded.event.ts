import type { IEvent } from '@nestjs/cqrs';
import { PLATFORM_TENANT_ID } from '@platform/common';

/**
 * A Checkout Session was paid. Applied by `Payment.complete()` and published on the CQRS event bus
 * only after the webhook transaction committed; `PaymentSucceededRelay` forwards it to Kafka as
 * `billing.payment-succeeded.v1`.
 *
 * `eventId` (uuidv7) becomes the Kafka envelope id, so a re-published event keeps its identity and
 * consumers (receipt mail, notification) stay idempotent.
 */
export class PaymentSucceededEvent implements IEvent {
  constructor(
    readonly eventId: string,
    readonly paymentId: string,
    readonly userId: string,
    readonly stripeCheckoutSessionId: string,
    /** Minor currency units (cents). */
    readonly amountTotal: number,
    /** ISO 4217, lowercase (Stripe convention). */
    readonly currency: string,
    readonly paidAt: Date,
    /** Stripe PaymentIntent (`pi_…`), when Stripe reported one. */
    readonly stripePaymentIntentId: string | null = null,
    /** The payment's tenant (the Kafka envelope tenantId). */
    readonly tenantId: string = PLATFORM_TENANT_ID,
  ) {}
}

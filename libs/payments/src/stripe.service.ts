import { DomainValidationException } from '@app/common';
import { type StripeConfig, stripeConfig } from '@app/config';
import { Inject, Injectable } from '@nestjs/common';
import Stripe from 'stripe';
import { InjectStripe, STRIPE_WEBHOOK_TOLERANCE_SEC } from './stripe.constants.js';
import { PaymentErrorCode, toPaymentDomainException } from './stripe.errors.js';
import type { CreateCheckoutSessionInput } from './stripe.types.js';

/**
 * Thin, typed facade over the Stripe SDK used by the billing domain. It owns the two concerns
 * that must be done identically everywhere: idempotent writes and webhook signature
 * verification — and it translates SDK errors into `DomainException`s.
 */
@Injectable()
export class StripeService {
  constructor(
    @InjectStripe() readonly client: Stripe,
    @Inject(stripeConfig.KEY) private readonly cfg: StripeConfig,
  ) {}

  /**
   * Creates a hosted Checkout Session (`mode: 'payment'`). Pass an `idempotencyKey` derived from a
   * business id (e.g. `checkout-${paymentId}`): a client retry then returns the SAME session
   * instead of creating a second one (Stripe keeps keys for 24h).
   */
  async createCheckoutSession(
    input: CreateCheckoutSessionInput,
    idempotencyKey?: string,
  ): Promise<Stripe.Checkout.Session> {
    const params: Stripe.Checkout.SessionCreateParams = {
      mode: 'payment',
      customer_email: input.customerEmail,
      client_reference_id: input.clientReferenceId,
      line_items: [{ price: input.priceId, quantity: input.quantity }],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      metadata: input.metadata,
      // Also on the PaymentIntent so `payment_intent.*` webhooks can be correlated without a lookup.
      payment_intent_data: { metadata: input.metadata },
    };
    try {
      return await this.client.checkout.sessions.create(
        params,
        idempotencyKey === undefined ? undefined : { idempotencyKey },
      );
    } catch (error) {
      throw toPaymentDomainException(error) ?? error;
    }
  }

  /**
   * Verifies the `Stripe-Signature` header (HMAC-SHA256 with the endpoint secret, timestamp within
   * 5 min) and parses the event. `payload` MUST be the raw request bytes — re-serialized JSON never
   * verifies. Synchronous `constructEvent` on purpose: node:crypto HMAC is the cheapest path.
   *
   * @throws DomainValidationException `INVALID_WEBHOOK_SIGNATURE` (missing/forged/stale signature)
   *   or `INVALID_WEBHOOK_PAYLOAD` (signed but not a JSON event).
   */
  constructWebhookEvent(payload: Buffer, signature: string | undefined): Stripe.Event {
    if (!signature) {
      throw new DomainValidationException('Missing webhook signature', {
        code: PaymentErrorCode.INVALID_WEBHOOK_SIGNATURE,
      });
    }
    try {
      return this.client.webhooks.constructEvent(
        payload,
        signature,
        this.cfg.webhookSecret,
        STRIPE_WEBHOOK_TOLERANCE_SEC,
      );
    } catch (error) {
      if (error instanceof Stripe.errors.StripeSignatureVerificationError) {
        throw new DomainValidationException('Invalid webhook signature', {
          code: PaymentErrorCode.INVALID_WEBHOOK_SIGNATURE,
          cause: error,
        });
      }
      if (error instanceof SyntaxError) {
        throw new DomainValidationException('Invalid webhook payload', {
          code: PaymentErrorCode.INVALID_WEBHOOK_PAYLOAD,
          cause: error,
        });
      }
      throw error;
    }
  }
}

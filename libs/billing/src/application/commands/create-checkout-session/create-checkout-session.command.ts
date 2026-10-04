import type { CheckoutSession, CreateCheckoutSessionRequest } from '@app/contracts';
import { Command } from '@nestjs/cqrs';

/**
 * Starts a Stripe Checkout for `quantity × priceId` and records a `pending` payment.
 * Idempotent per `(userId, idempotencyKey)`: a replay returns the same session.
 */
export class CreateCheckoutSessionCommand extends Command<CheckoutSession> {
  constructor(readonly request: CreateCheckoutSessionRequest) {
    super();
  }
}

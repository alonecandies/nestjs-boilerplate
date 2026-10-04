import type { HandleStripeWebhookResponse } from '@app/contracts';
import { Command } from '@nestjs/cqrs';

/** A Stripe webhook delivery, exactly as received: raw body bytes + `Stripe-Signature` header. */
export class HandleStripeWebhookCommand extends Command<HandleStripeWebhookResponse> {
  constructor(
    /** The untouched request body — the signature covers these exact bytes. */
    readonly payload: Buffer,
    readonly signature: string | undefined,
  ) {
    super();
  }
}

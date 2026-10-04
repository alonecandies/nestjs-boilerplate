import type {
  CheckoutSession,
  CreateCheckoutSessionRequest,
  HandleStripeWebhookRequest,
  HandleStripeWebhookResponse,
  ListPaymentsRequest,
  PaymentList,
} from '@app/contracts';

/**
 * The billing API as seen by presentation code (REST controller, GraphQL resolver). Bound to
 * `BillingLocalAdapter` (CQRS buses, monolith) or `BillingGrpcAdapter` (gateway →
 * billing-service) by `BillingApiModule.forLocal()` / `.forRemote()`. Both return the same
 * `@app/contracts` shapes, so presentation code cannot tell them apart.
 */
export abstract class BillingPort {
  /** Stripe Checkout Session + `pending` payment row. Idempotent per `(userId, idempotencyKey)`. */
  abstract createCheckoutSession(input: CreateCheckoutSessionRequest): Promise<CheckoutSession>;

  /** Verifies the signature over the raw bytes and applies the event exactly once. */
  abstract handleStripeWebhook(
    input: HandleStripeWebhookRequest,
  ): Promise<HandleStripeWebhookResponse>;

  /** Newest first. `userId` omitted = every user's payments (callers enforce `billing:read-all`). */
  abstract listPayments(input: ListPaymentsRequest): Promise<PaymentList>;
}

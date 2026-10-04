/** Input of `StripeService.createCheckoutSession` (one-off payment for a single price). */
export interface CreateCheckoutSessionInput {
  /** Pre-fills the Checkout email field and receives Stripe's receipt. */
  customerEmail: string;
  /** Stripe Price id (`price_…`). */
  priceId: string;
  quantity: number;
  /** Absolute URLs. `{CHECKOUT_SESSION_ID}` is substituted by Stripe. */
  successUrl: string;
  cancelUrl: string;
  /** Our reference (e.g. payment id) — echoed back on the session and in webhooks. */
  clientReferenceId: string;
  /** String-only key/values (Stripe limit: 50 keys, 500-char values); copied to the PaymentIntent too. */
  metadata: Record<string, string>;
}

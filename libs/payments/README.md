# @app/payments

Stripe integration for the billing context: one process-wide Stripe client, a small typed facade
(`StripeService`) for idempotent Checkout Sessions and webhook signature verification, and a mapper
that turns Stripe SDK errors into `DomainException`s so billing code never sees `Stripe.errors.*`.

## Public API

| Export                                                          | Kind              | Purpose                                                                                                                                                                                                   |
| --------------------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `StripeModule.forRootAsync(): DynamicModule`                    | global module     | Registers `STRIPE_CLIENT` + `StripeService` from the `stripe` config namespace (loads `ConfigModule.forFeature(stripeConfig)` itself).                                                                    |
| `StripeService`                                                 | provider          | `createCheckoutSession(input, idempotencyKey?)`, `constructWebhookEvent(payload, signature)`, `client` (raw SDK).                                                                                         |
| `createStripeClient(cfg: StripeConfig): Stripe`                 | function          | Builds the SDK client (used by the module and by tests).                                                                                                                                                  |
| `STRIPE_CLIENT` / `InjectStripe()`                              | token / decorator | Raw `Stripe` instance for calls the facade doesn't wrap.                                                                                                                                                  |
| `CreateCheckoutSessionInput`                                    | type              | `{ customerEmail, priceId, quantity, successUrl, cancelUrl, clientReferenceId, metadata }`.                                                                                                               |
| `toPaymentDomainException(error): DomainException \| undefined` | function          | Stripe SDK error → `DomainException` (`undefined` for non-Stripe values).                                                                                                                                 |
| `PaymentErrorCode`                                              | const + type      | Stable codes: `INVALID_WEBHOOK_SIGNATURE`, `INVALID_WEBHOOK_PAYLOAD`, `PAYMENT_REQUEST_INVALID`, `PAYMENT_DECLINED`, `IDEMPOTENCY_KEY_REUSED`, `PAYMENT_PROVIDER_RATE_LIMITED`, `PAYMENT_PROVIDER_ERROR`. |
| `STRIPE_WEBHOOK_TOLERANCE_SEC` (300), `STRIPE_APP_INFO`         | constants         | Replay window for webhook timestamps; app info sent to Stripe.                                                                                                                                            |

Error mapping (`toPaymentDomainException`):

| Stripe error                | DomainException                                               | Code                            |
| --------------------------- | ------------------------------------------------------------- | ------------------------------- |
| `StripeIdempotencyError`    | `DomainConflictException` (409)                               | `IDEMPOTENCY_KEY_REUSED`        |
| `StripeCardError`           | `BusinessRuleViolationException` (422, `details.declineCode`) | `PAYMENT_DECLINED`              |
| `StripeInvalidRequestError` | `DomainValidationException` (422, issue at `param`)           | `PAYMENT_REQUEST_INVALID`       |
| `StripeRateLimitError`      | `ServiceUnavailableException` (503)                           | `PAYMENT_PROVIDER_RATE_LIMITED` |
| anything else from Stripe   | `ExternalServiceException` (502, generic message)             | `PAYMENT_PROVIDER_ERROR`        |

`details.stripeRequestId` is attached when Stripe returned one (useful when opening a support ticket).

## Usage

```ts
// app.module.ts (billing-service / monolith)
@Module({ imports: [AppConfigModule.forRoot(), StripeModule.forRootAsync()] })
export class AppModule {}

// application layer
@Injectable()
export class CreateCheckoutSessionHandler {
  constructor(private readonly stripe: StripeService) {}

  async execute(payment: Payment): Promise<Stripe.Checkout.Session> {
    return this.stripe.createCheckoutSession(
      {
        customerEmail: payment.email,
        priceId: payment.priceId,
        quantity: payment.quantity,
        successUrl: cfg.successUrl,
        cancelUrl: cfg.cancelUrl,
        clientReferenceId: payment.id,
        metadata: { paymentId: payment.id, userId: payment.userId },
      },
      `checkout-${payment.id}`, // client retries return the SAME session
    );
  }
}

// webhook (raw body!)
const event = this.stripe.constructWebhookEvent(req.rawBody, headers['stripe-signature']);
```

## Environment

From the `stripe` namespace of `@app/config`: `STRIPE_SECRET_KEY` (must start `sk_`/`rk_`),
`STRIPE_WEBHOOK_SECRET` (must start `whsec_`; both dev placeholders are rejected when
`NODE_ENV=production`), `STRIPE_MAX_NETWORK_RETRIES` (2), `STRIPE_TIMEOUT_MS`
(20000). `STRIPE_SUCCESS_URL` / `STRIPE_CANCEL_URL` are read by the billing domain, not here.

## Gotchas

- **Raw body.** The signature covers the exact request bytes. Create the app with `rawBody: true` and
  pass `req.rawBody`. Re-serialized JSON never verifies (a test covers this).
- **`apiVersion` is left out on purpose.** Stripe 22 types it as the SDK's pinned literal, so the API
  version moves with SDK upgrades. Pin the webhook endpoint in the dashboard to the same version.
- The webhook route must be `@Public()` and skip throttling. Reply 2xx fast, and make processing
  idempotent by `event.id`: Stripe retries, and may deliver duplicates or deliver out of order.
- `StripeService.constructWebhookEvent` is synchronous on purpose (node:crypto HMAC is the cheapest path).
  Timestamps older than 5 minutes are rejected, which protects against replays.
- The SDK already keeps connections alive and retries 409/429/5xx/network errors, adding
  idempotency keys to retried POSTs. Still pass your own business-derived key.
- Tests: sign payloads with `Stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp? })`.

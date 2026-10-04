# @app/billing

The billing bounded context. It creates **Stripe Checkout Sessions** (idempotently) backed by a
`pending` payment row, applies **signed Stripe webhooks exactly once**, keeps the **payments ledger**
(Postgres via Drizzle) and announces paid checkouts as the `billing.payment-succeeded.v1` Kafka event,
which notifications turns into a receipt mail and an in-app notification.

Layers follow the hexagonal/CQRS layout of the monorepo:

```
src/
  domain/          Payment aggregate (status machine), PaymentSucceededEvent, errors, PaymentStatus
  application/     commands (CreateCheckoutSession, HandleStripeWebhook), query (ListPayments),
                   PaymentSucceededRelay (→ Kafka), BillingPort, repository abstractions, mapper
  infrastructure/  billing.schema.ts (Drizzle), Drizzle repositories, local + gRPC port adapters
  presentation/    REST BillingController, GraphQL BillingResolver, gRPC BillingGrpcController
  billing-core.module.ts · billing-grpc.module.ts · billing-api.module.ts
```

## Modules and wiring

| Module                         | Contents                                                                                                        | Used by          |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------- | ---------------- |
| `BillingCoreModule`            | CQRS handlers, `PaymentSucceededRelay`, Drizzle repositories                                                    | (via the others) |
| `BillingGrpcModule`            | `BillingCoreModule` + `BillingGrpcController` (`billing.v1.BillingService`)                                     | billing-service  |
| `BillingApiModule.forLocal()`  | `BillingController` + `BillingResolver` + `BillingPort → BillingLocalAdapter` + `BillingCoreModule`             | monolith         |
| `BillingApiModule.forRemote()` | `BillingController` + `BillingResolver` + `BillingPort → BillingGrpcAdapter` + `GrpcClientsModule(['billing'])` | gateway          |

The REST controller and GraphQL resolver are the same classes in both topologies; they only know
`BillingPort`. Both adapters return the `@app/contracts` `billing.v1` shapes.

```ts
// billing-service (HTTP :3003 for /health + /metrics, gRPC :50053)
@Module({
  imports: [
    AppConfigModule.forRoot(),
    ObservabilityModule.forRoot({
      healthContributors: [DatabaseHealthIndicator, RedisHealthIndicator, KafkaHealthIndicator],
    }),
    CqrsModule.forRoot(),
    DatabaseModule.forRootAsync({ schema: billingSchema }),
    RedisModule.forRootAsync(),
    KafkaProducerModule.forRootAsync(),
    StripeModule.forRootAsync(),
    BillingGrpcModule,
  ],
})
export class AppModule {}
// main.ts: createServiceApp(AppModule) → connectGrpcServer(app, ['billing']) → startAllMicroservices → listen

// monolith: CqrsModule.forRoot(), DatabaseModule.forRootAsync({ schema: { ...identitySchema, ...billingSchema } }),
//           KafkaProducerModule, StripeModule, AuthModule, AppThrottlerModule, AppGraphqlModule,
//           IdentityApiModule.forLocal(), BillingApiModule.forLocal(), …
// gateway:  AuthModule, AppThrottlerModule, AppGraphqlModule, IdentityApiModule.forRemote(), BillingApiModule.forRemote(), …
// both:     createHttpApp(AppModule, { rawBody: true }) — the Stripe webhook verifies the raw bytes.
```

What the edge (monolith / gateway) must provide:

- `AuthModule.forRootAsync()` (global JWT → roles → permissions guards; import it before `AppThrottlerModule`).
- `provideCommonEnhancers*()`: both validation pipes (class-validator for GraphQL inputs, Standard Schema for
  the zod REST bodies/queries) and the problem+json filter.
- `AppGraphqlModule.forRootAsync()` and **identity's Api module**: it registers the `users` DataLoader behind
  `Payment.user` and the `User` GraphQL type.
- An HTTP app created with `rawBody: true` (`req.rawBody` for `application/json`).
- `nestjs-cls` (from `ObservabilityModule`) is used by the gRPC adapter to propagate request/correlation ids.

`BillingCoreModule` expects the global `CqrsModule.forRoot()`, `DatabaseModule` (DRIZZLE + `@Transactional()`),
`StripeModule` and `KafkaProducerModule`; it loads the `stripe` config namespace itself.

## API

### REST (`/v1/billing`)

| Method & path             | Auth                                           | Input                                                                                                                                             | Response                                                                                                                       |
| ------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `POST /checkout-sessions` | Bearer, `billing:checkout`                     | zod body `{ priceId: string(1..255), quantity?: int 1..100 = 1 }` (strict) + optional `Idempotency-Key` header (8–255 chars of `[A-Za-z0-9._:-]`) | `201 { id, url, paymentId }`                                                                                                   |
| `POST /webhooks/stripe`   | `@Public`, `@SkipThrottle`, `Stripe-Signature` | raw JSON body (verified byte-for-byte)                                                                                                            | `200 { received, eventId, eventType, duplicate }`                                                                              |
| `GET /payments`           | Bearer; `?all=true` needs `billing:read-all`   | zod query `{ all?: 'true'\|'false'\|'1'\|'0', limit?: 1..100 = 20, cursor?: string }`                                                             | `200 { items: Payment[], nextCursor: string \| null }` newest first, keyset-paginated (`amountTotal` = minor units, ISO dates) |

Errors are RFC 9457 `application/problem+json`: 400 (validation, `errors[]`), 401, 403, 409
(`IDEMPOTENCY_KEY_REUSED`, `PAYMENT_CONCURRENTLY_MODIFIED`), 422 (`INVALID_WEBHOOK_SIGNATURE`,
`INVALID_WEBHOOK_PAYLOAD`, `INVALID_CURSOR`), 502 (`PAYMENT_PROVIDER_ERROR`, `CHECKOUT_URL_MISSING`). Responses are enforced by
`StandardSchemaSerializerInterceptor` (unknown fields are stripped) and documented in OpenAPI from the same zod schemas.

### GraphQL

```graphql
type Query {
  # all: true needs billing:read-all; cursor = the previous page's nextCursor
  payments(all: Boolean! = false, limit: Int! = 20, cursor: String): PaymentConnection!
}
type PaymentConnection {
  items: [Payment!]!
  nextCursor: String # null on the last page
}
type Mutation {
  createCheckoutSession(input: CreateCheckoutSessionInput!): CheckoutSession! # billing:checkout
}
type Payment {
  id: ID!
  userId: UUID!
  status: PaymentStatus!
  amountTotal: Float!
  currency: String!
  priceId: String!
  quantity: Int!
  stripeCheckoutSessionId: String
  createdAt: DateTime
  updatedAt: DateTime
  user: User # batched through identity's `users` DataLoader
}
enum PaymentStatus {
  PENDING
  SUCCEEDED
  FAILED
  EXPIRED
}
type CheckoutSession {
  id: ID!
  url: String!
  paymentId: UUID!
}
input CreateCheckoutSessionInput {
  priceId: String!
  quantity: Int! = 1
  idempotencyKey: String
}
```

`payments(all: true)` needs `billing:read-all`. N payments cost one batched user lookup, not N.
`amountTotal` is a `Float` holding integer minor units (GraphQL `Int` is 32-bit).

### gRPC (`billing.v1.BillingService`, billing-service)

| RPC                     | → bus                          | Notes                                                                                                                                            |
| ----------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CreateCheckoutSession` | `CreateCheckoutSessionCommand` | zod-validated; optional `success_url`/`cancel_url` (internal callers only)                                                                       |
| `HandleStripeWebhook`   | `HandleStripeWebhookCommand`   | `payload` is `bytes` (Buffer): the service verifies the signature                                                                                |
| `ListPayments`          | `ListPaymentsQuery`            | `user_id` absent = all users (the gateway enforces `billing:read-all`); `limit` 0 = 20; `cursor` in, `next_cursor` out (absent on the last page) |

Payloads go through `ZodRpcValidationPipe` (`INVALID_ARGUMENT` + issues); `@GrpcController()` maps domain
errors to gRPC statuses and `x-error-code` trailers, and `BillingGrpcAdapter` maps them back to the same
`DomainException`s (deadline = `GRPC_DEADLINE_MS`, circuit breaker `billing`).

### Kafka (produced)

| Topic                          | Key      | Payload (`paymentSucceededPayload`)                                                                            |
| ------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------- |
| `billing.payment-succeeded.v1` | `userId` | `{ paymentId, userId, stripeCheckoutSessionId, amountTotal, currency, paidAt }`; envelope id = domain event id |

Billing consumes no topic.

## Flows

**Checkout** (`CreateCheckoutSessionHandler`): insert a `pending` payment (or find the one this user's
`Idempotency-Key` already created — unique `(user_id, idempotency_key)`; a different price/quantity is 409) →
`StripeService.createCheckoutSession` with Stripe idempotency key `checkout-<paymentId>`,
`client_reference_id = paymentId` and `metadata { paymentId, userId }` → bind the session id, amount and currency
(optimistic lock on `version`). No transaction spans the Stripe call; every step is safe to repeat. A Stripe
failure marks the payment `failed`; a retry with the same key reopens it and gets the same session.

**Webhook** (`HandleStripeWebhookHandler`):

1. `StripeService.constructWebhookEvent(rawBody, signature)`: missing, forged or stale (> 5 min) signatures are a
   422 before any I/O.
2. `@Transactional()`: `INSERT INTO stripe_events … ON CONFLICT (id) DO NOTHING` — a duplicate delivery returns
   `duplicate: true` — then load the payment `FOR UPDATE` (by `client_reference_id`, else session id) and apply:
   - `checkout.session.completed` / `async_payment_succeeded` (paid) → `succeeded` + `PaymentSucceededEvent`
     (a completed-but-`unpaid` session, i.e. a delayed payment method, stays `pending`);
   - `checkout.session.async_payment_failed` → `failed`; `checkout.session.expired` → `expired`;
   - any other signed event → acknowledged and ignored.
3. After COMMIT the aggregate's events are published; `PaymentSucceededRelay` sends the Kafka event.

Unknown payments and impossible transitions are acknowledged with a warning (a retry could never succeed).
A paid session with no usable currency (none in the event, none stored) is one of them: the payment stays
`pending` and is NOT announced (`billing.payment-succeeded.v1` requires an ISO 4217 code), the handler warns and
increments `billing_checkout_paid_without_currency_total` — alert on it and reconcile in the Stripe dashboard.
Infrastructure errors propagate, the transaction rolls back (forgetting the event id) and Stripe's retry is
processed again. Old receipts are purged: see **Retention** below.

**Pagination.** `list` is keyset-paginated on the uuidv7 id (`@app/database` `keysetFetchLimit`/`keysetPage`):
`WHERE user_id = $1 [AND id < $cursor] ORDER BY id DESC LIMIT n + 1` on `payments_user_id_id_idx` (the admin
listing uses the primary key). Cursors are opaque; a forged one is a 422 `INVALID_CURSOR`, never SQL.

**Retention.** `PurgeStripeEventsCron` (hourly, `@WithLock('billing:purge-stripe-events')` so one replica runs
it) deletes `stripe_events` older than `STRIPE_EVENTS_RETENTION_DAYS` (30; Stripe redelivers for ≤ 3 days) in
batches of 5,000 via `PurgeStripeEventsCommand`. It needs `ScheduleModule.forRoot()` and `RedisModule` in the
app (billing-service and the monolith import both).

**Consistency.** The relay publishes after commit and only logs failures, so a crash between COMMIT and the Kafka
ack loses the event. Guaranteed delivery needs a transactional outbox (a `billing_outbox` row written inside the
webhook transaction, relayed by a poller); the envelope id is already the stable domain event id, so consumers
dedupe replays either way.

## Data model (`billingSchema`, `infrastructure/persistence/billing.schema.ts`)

| Table           | Columns                                                                                                                                                                                                                                                                                                                                                       | Indexes                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `payments`      | `id uuid pk` (app uuidv7, DB default `uuidv7()`), `user_id uuid` (no FK: service boundary), `price_id`, `quantity int`, `amount_total int8` (minor units, NULL until priced), `currency`, `status payment_status`, `stripe_checkout_session_id` (unique), `stripe_payment_intent_id`, `idempotency_key`, `paid_at`, `version int`, `created_at`, `updated_at` | `(user_id, id)` for "my payments, newest first"; unique `(user_id, idempotency_key)`; unique session id |
| `stripe_events` | `id text pk` (Stripe `evt_…`), `type`, `processed_at`                                                                                                                                                                                                                                                                                                         | PK = the idempotency key; `stripe_events_processed_at_idx` for the retention purge                      |

`payment_status` enum: `pending`, `succeeded`, `failed`, `expired`. Constraint names are explicit snake_case
(`payments_stripe_checkout_session_id_unique`). Migrations are generated by drizzle-kit into
`libs/database/src/migrations` (initial: `0000_init.sql`; `0002_stripe_events_processed_at_idx.sql`) (the schema file imports only `drizzle-orm` and a dependency-free enum file, so
drizzle-kit can load it). Reads (`findById`, `list`) use prepared statements on the pool; writes and row locks go
through `TransactionHost` and join the active transaction.

## Configuration

`stripe` namespace: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_SUCCESS_URL`, `STRIPE_CANCEL_URL`
(redirect URLs are never taken from REST clients: no open redirect), `STRIPE_MAX_NETWORK_RETRIES`,
`STRIPE_TIMEOUT_MS`. Gateway: `BILLING_GRPC_URL`, `GRPC_DEADLINE_MS`.

## Tests

`bunx vitest run --project billing` — no infrastructure needed:

- `payment.aggregate.spec.ts` — status machine, event applied once, idempotent replays.
- Handlers: checkout (mocked `StripeService`: idempotency per user, key reuse 409, failure → `failed` → retry,
  missing URL), webhook (real signature verification with `stripe.webhooks.generateTestHeaderString`: valid,
  duplicate, ignored type, invalid/missing/tampered signature, async payments, expiry, unknown payment, rollback on
  infrastructure error, events published only after the transaction), list (limit normalisation).
- Mappers (contract + row), relay (`FakeKafkaProducer`, failure swallowed), local adapter (bus mapping), gRPC
  adapter (null normalisation, metadata, error mapping), gRPC controller (bus mapping, zod payload schemas).
- Drizzle repositories: real Drizzle SQL generation on a recording postgres.js fake (ON CONFLICT targets,
  `FOR UPDATE`, optimistic lock, prepared list statements).
- `billing.controller.spec.ts` — Fastify app with the real `AuthModule` guards (tokens from `TokenService`):
  401/403, 400 validation (body, query, `Idempotency-Key`), serialisation, raw-body webhook, OpenAPI document.
- `billing.resolver.spec.ts` — Apollo on Fastify: payments + batched `user` field, RBAC, input validation.
- `test/stripe-webhook.flow.spec.ts` — raw body → controller → local adapter → handler → relay → Kafka fake.
- `billing.modules.spec.ts` — DI wiring of `BillingGrpcModule`, `BillingApiModule.forLocal()` / `.forRemote()`.
- `billing-identity.composition.spec.ts` — the REAL `@app/identity` next to billing in one app (one CQRS bus, one
  GraphQL schema): `Payment.user` is identity's `User`, resolved through identity's `users` DataLoader → UsersPort →
  QueryBus → repository in ONE batched lookup; both REST surfaces served. (The other specs mock `@app/identity`.)
- `presentation/grpc/billing-grpc.roundtrip.spec.ts` — `BillingApiModule.forRemote()` ↔ `BillingGrpcController`
  over real loopback gRPC: the remote adapter returns the local mapper's exact shape (int64 string, Date, absent
  optionals), webhook bytes arrive untouched, domain codes survive the hop.

## Gotchas

- The webhook route must receive the **raw body** (`createHttpApp(…, { rawBody: true })`); re-serialised JSON
  never verifies. It is `@Public()` and `@SkipThrottle()` — Stripe retries on any non-2xx.
- Stripe idempotency keys are account-wide, so the client `Idempotency-Key` is never forwarded verbatim; it is
  mapped per user to a payment id, and the Stripe key is `checkout-<paymentId>`.
- `billing.schema.ts` may only import `drizzle-orm` and dependency-free relative files (drizzle-kit loader).
- `@app/billing`'s barrel imports `@app/identity` (for `UserModel`), so billing-service also loads identity's code.

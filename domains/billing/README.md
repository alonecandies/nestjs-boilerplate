# @domain/billing

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
  infrastructure/  billing.schema.ts (Drizzle), Drizzle repositories, local + gRPC port adapters, the Stripe adapter (stripe/)
  presentation/    REST BillingController, GraphQL BillingResolver, gRPC BillingGrpcController
  billing-core.module.ts · billing-grpc.module.ts · billing-api.module.ts
```

## Modules and wiring

| Module                         | Contents                                                                                                                                         | Used by          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| `BillingCoreModule`            | CQRS handlers, `PaymentSucceededRelay`, Drizzle repositories, the Stripe adapter (`StripeModule.forRootAsync()`)                                 | (via the others) |
| `BillingGrpcModule`            | `BillingCoreModule` + `BillingGrpcController` (`billing.v1.BillingService`)                                                                      | billing-service  |
| `BillingApiModule.forLocal()`  | `BillingController` + `BillingResolver` + `BillingPort → BillingLocalAdapter` (the app imports `BillingCoreModule` too)                          | monolith         |
| `BillingApiModule.forRemote()` | `BillingController` + `BillingResolver` + `BillingPort → BillingGrpcAdapter` + `GrpcClientsModule.register({ spec: BILLING_GRPC_PACKAGE, url })` | gateway          |

Entry points: `@domain/billing/api` (edge: `BillingApiModule`, `BillingPort` and its adapters, gRPC client config,
GraphQL/REST presentation, log-redaction paths; what the gateway imports) and `@domain/billing` (everything in
`./api` plus core, persistence, Stripe, commands, queries, domain). No `./testing`.

The REST controller and GraphQL resolver are the same classes in both topologies; they only know
`BillingPort`. Both adapters return the `@domain/billing-contracts` `billing.v1` shapes.

```ts
// apps/billing-service/src/app.module.ts (HTTP :3003 for /health + /metrics, gRPC :50053)
import { DATABASE_MIGRATIONS } from './database.migrations.js'; // [billingMigrations], also migrate.ts

@Module({
  imports: [
    AppConfigModule.forRoot(),
    ConfigModule.forFeature(grpcConfig), // GRPC_URL for connectGrpcServer in main.ts
    // Readiness = Postgres + Redis. Kafka is deliberately NOT a contributor (best-effort publish).
    ObservabilityModule.forRoot({
      healthContributors: [DatabaseHealthIndicator, RedisHealthIndicator],
    }),
    CqrsModule.forRoot(),
    ScheduleModule.forRoot(), // PurgeStripeEventsCron
    DatabaseModule.forRootAsync({ schema: billingSchema, migrations: DATABASE_MIGRATIONS }),
    RedisModule.forRootAsync(),
    KafkaProducerModule.forRootAsync(),
    BillingGrpcModule,
  ],
  providers: [
    ...provideCommonEnhancersAsync({
      inject: [appConfig.KEY],
      useFactory: (app: AppConfig) => ({
        exposeInternalErrors: !app.isProduction,
        defaultTimeoutMs: app.handlerTimeoutMs,
      }),
    }),
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(CorrelationIdMiddleware)
      .forRoutes({ path: '{*splat}', method: RequestMethod.ALL });
  }
}
// main.ts: createServiceApp(AppModule) → connectGrpcServer(app, [BILLING_GRPC_PACKAGE]) → startAllMicroservices → listen

// monolith: CqrsModule.forRoot(), DatabaseModule.forRootAsync({ schema: { ...identitySchema, ...billingSchema }, migrations: [identityMigrations, billingMigrations] }),
//           KafkaProducerModule, AuthModule, AppThrottlerModule, AppGraphqlModule,
//           IdentityCoreModule, IdentityApiModule.forLocal(), BillingCoreModule, BillingApiModule.forLocal(), …
// gateway:  AuthModule, AppThrottlerModule, AppGraphqlModule, IdentityApiModule.forRemote(), BillingApiModule.forRemote(), …
// both:     createHttpApp(AppModule, { rawBody: true }) — the Stripe webhook verifies the raw bytes.
```

What the edge (monolith / gateway) must provide:

- `AuthModule.forRootAsync()` (global JWT → roles → permissions guards; import it before `AppThrottlerModule`).
- `provideCommonEnhancers*()`: both validation pipes (class-validator for GraphQL inputs, Standard Schema for
  the zod REST bodies/queries) and the problem+json filter.
- `AppGraphqlModule.forRootAsync()`. Billing exposes a payment's owner as `Payment.userId` only: the apps add
  `Payment.user` (`PaymentUserFieldResolver` in `apps/monolith` and `apps/gateway`, over identity's `users`
  DataLoader), so billing never imports identity.
- An HTTP app created with `rawBody: true` (`req.rawBody` for `application/json`).
- `BILLING_LOG_REDACT_PATHS` in the logger's redact paths, so the `stripe-signature` header is never logged:
  `ObservabilityModule.forRoot({ redactPaths: BILLING_LOG_REDACT_PATHS })`. An HTTP edge serving the Stripe webhook
  needs it (monolith, gateway); billing-service receives the webhook over gRPC and needs none.
- `nestjs-cls` (from `ObservabilityModule`) is used by the gRPC adapter to propagate request/correlation ids.

`BillingCoreModule` expects the global `CqrsModule.forRoot()`, `DatabaseModule` (DRIZZLE + `@Transactional()`)
and `KafkaProducerModule`. It imports its own Stripe adapter (`StripeModule.forRootAsync()`, below) and loads the
`stripe` config namespace itself, so no app imports Stripe.

## API

### REST (`/v1/billing`)

| Method & path             | Auth                                            | Input                                                                                                                                             | Response                                                                                                                       |
| ------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `POST /checkout-sessions` | Bearer, `billing:checkout`                      | zod body `{ priceId: string(1..255), quantity?: int 1..100 = 1 }` (strict) + optional `Idempotency-Key` header (8–255 chars of `[A-Za-z0-9._:-]`) | `201 { id, url, paymentId }`                                                                                                   |
| `POST /webhooks/stripe`   | `@Public`, `@SkipRateLimit`, `Stripe-Signature` | raw JSON body (verified byte-for-byte)                                                                                                            | `200 { received, eventId, eventType, duplicate }`                                                                              |
| `GET /payments`           | Bearer; `?all=true` needs `billing:read-all`    | zod query `{ all?: 'true'\|'false'\|'1'\|'0', limit?: 1..100 = 20, cursor?: string }`                                                             | `200 { items: Payment[], nextCursor: string \| null }` newest first, keyset-paginated (`amountTotal` = minor units, ISO dates) |

Errors are RFC 9457 `application/problem+json`: 400 (validation, `errors[]`), 401, 403, 409
(`IDEMPOTENCY_KEY_REUSED`, `PAYMENT_CONCURRENTLY_MODIFIED`), 422 (`INVALID_WEBHOOK_SIGNATURE`,
`INVALID_WEBHOOK_PAYLOAD`, `INVALID_CURSOR`), 502 (`PAYMENT_PROVIDER_ERROR`, `CHECKOUT_URL_MISSING`). Responses are enforced by
`StandardSchemaSerializerInterceptor` (unknown fields are stripped) and documented in OpenAPI from the same zod schemas. Every billing code, the Stripe adapter's included, is a `BillingErrorCode` value.

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
  user: User # added by the apps (PaymentUserFieldResolver), batched through identity's `users` DataLoader
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

## Stripe adapter (`infrastructure/stripe`)

One process-wide Stripe client, a small typed facade (`StripeService`) for idempotent Checkout Sessions and
webhook signature verification, and a mapper that turns Stripe SDK errors into `DomainException`s, so the
handlers never see `Stripe.errors.*`. (It used to be the `@platform/payments` package.)

| Export                                                          | Kind              | Purpose                                                                                                      |
| --------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------ |
| `StripeModule.forRootAsync(): DynamicModule`                    | module            | `STRIPE_CLIENT` + `StripeService` from the `stripe` namespace. Imported by `BillingCoreModule` (not global). |
| `StripeService`                                                 | provider          | `createCheckoutSession(input, idempotencyKey?)`, `constructWebhookEvent(payload, signature)`, `client`.      |
| `createStripeClient(cfg: StripeConfig): Stripe`                 | function          | Builds the SDK client (used by the module and by tests).                                                     |
| `STRIPE_CLIENT` / `InjectStripe()`                              | token / decorator | Raw `Stripe` instance for calls the facade doesn't wrap.                                                     |
| `StripeCheckoutSessionInput`                                    | type              | `{ customerEmail, priceId, quantity, successUrl, cancelUrl, clientReferenceId, metadata }`.                  |
| `toPaymentDomainException(error): DomainException \| undefined` | function          | Stripe SDK error → `DomainException` (`undefined` for non-Stripe values).                                    |
| `STRIPE_WEBHOOK_TOLERANCE_SEC` (300), `STRIPE_APP_INFO`         | constants         | Replay window for webhook timestamps; app info sent to Stripe.                                               |

| Stripe error                | DomainException                                               | `BillingErrorCode`              |
| --------------------------- | ------------------------------------------------------------- | ------------------------------- |
| `StripeIdempotencyError`    | `DomainConflictException` (409)                               | `IDEMPOTENCY_KEY_REUSED`        |
| `StripeCardError`           | `BusinessRuleViolationException` (422, `details.declineCode`) | `PAYMENT_DECLINED`              |
| `StripeInvalidRequestError` | `DomainValidationException` (422, issue at `param`)           | `PAYMENT_REQUEST_INVALID`       |
| `StripeRateLimitError`      | `ServiceUnavailableException` (503)                           | `PAYMENT_PROVIDER_RATE_LIMITED` |
| anything else from Stripe   | `ExternalServiceException` (502, generic message)             | `PAYMENT_PROVIDER_ERROR`        |

`details.stripeRequestId` is attached when Stripe returned one. Webhook verification fails with 422
`INVALID_WEBHOOK_SIGNATURE` (missing, forged or stale signature) or `INVALID_WEBHOOK_PAYLOAD` (signed but not JSON).

**Environment.** The adapter reads the `stripe` config namespace: `STRIPE_SECRET_KEY` (must start `sk_`/`rk_`),
`STRIPE_WEBHOOK_SECRET` (must start `whsec_`; both dev placeholders are rejected when `NODE_ENV=production`),
`STRIPE_MAX_NETWORK_RETRIES` (2) and `STRIPE_TIMEOUT_MS` (20000). `STRIPE_SUCCESS_URL` / `STRIPE_CANCEL_URL` are read
by `CreateCheckoutSessionHandler`, not by the adapter.

- The webhook needs the **raw request body**: the signature covers the exact bytes. Create the app with
  `rawBody: true` and pass `req.rawBody`; re-serialised JSON never verifies (a test covers this).
- The webhook route must be `@Public()` and skip throttling. Reply 2xx fast and make processing idempotent by
  `event.id`: Stripe retries, and may deliver duplicates or deliver out of order.
- `apiVersion` is left out on purpose: the SDK types it as its pinned literal, so the API version moves with SDK
  upgrades. Pin the webhook endpoint in the dashboard to the same version.
- `constructWebhookEvent` is synchronous on purpose (node:crypto HMAC is the cheapest path).
- The SDK keeps connections alive and retries 409/429/5xx/network errors, adding idempotency keys to retried
  POSTs; the handlers still pass their own business key (`checkout-<paymentId>`).
- Tests sign payloads with `Stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp? })`.

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
2. `@Transactional()`: `INSERT INTO billing.stripe_events … ON CONFLICT (id) DO NOTHING` — a duplicate delivery returns
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

**Pagination.** `list` is keyset-paginated on the uuidv7 id (`@platform/database` `keysetFetchLimit`/`keysetPage`):
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
(`payments_stripe_checkout_session_id_unique`). The tables and the enum live in the `billing` Postgres schema
(`billingPgSchema`); raw SQL qualifies them (`billing.payments`). Billing owns its migration history:
`drizzle.config.ts` generates `src/infrastructure/persistence/migrations` (`0000_init.sql` holds every table and
index, `stripe_events_processed_at_idx` included), bookkeeping in `billing.__drizzle_migrations`, and
`billingMigrations` applies it after the platform set (the schema file imports only `drizzle-orm` and a
dependency-free enum file, so drizzle-kit can load it). Reads (`findById`, `list`) use prepared statements on the pool; writes and row locks go
through `TransactionHost` and join the active transaction.

## Configuration

`stripe` namespace (`src/infrastructure/stripe/stripe.config.ts`, owned by billing; production rejects the dev placeholders, the compose fallbacks and local redirect URLs): `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_SUCCESS_URL`, `STRIPE_CANCEL_URL`
(redirect URLs are never taken from REST clients: no open redirect), `STRIPE_MAX_NETWORK_RETRIES`,
`STRIPE_TIMEOUT_MS`. Gateway: `BILLING_GRPC_URL` (`billingGrpcClient` namespace, `src/infrastructure/adapters/grpc/billing-grpc-client.config.ts`), `GRPC_DEADLINE_MS` (platform `grpc`).

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
- `billing.migrations.spec.ts` — the migration set: its folder and `billing.__drizzle_migrations` bookkeeping,
  every table and enum in the `billing` schema, the match with `drizzle.config.ts`, and the baseline's
  `CREATE SCHEMA IF NOT EXISTS "billing";` first statement.
- `infrastructure/stripe/*.spec.ts` — the Stripe adapter: SDK error mapping, signature verification (valid, forged, stale, re-serialised, missing, not JSON), Checkout params and idempotency key, module wiring and the invalid-key boot failure.
- `billing.controller.spec.ts` — Fastify app with the real `AuthModule` guards (tokens from `signTestAccessToken`, `@platform/auth/testing`):
  401/403, 400 validation (body, query, `Idempotency-Key`), serialisation, raw-body webhook, OpenAPI document.
- `billing.resolver.spec.ts` — Apollo on Fastify: payments (owner as `userId`; billing defines no `user` field), RBAC, input validation.
- `test/stripe-webhook.flow.spec.ts` — raw body → controller → local adapter → handler → relay → Kafka fake.
- `billing.modules.spec.ts` — DI wiring of `BillingGrpcModule`, `BillingApiModule.forLocal()` / `.forRemote()`.
- `Payment.user` is tested where it is composed: `apps/monolith/test/payment-user.e2e-spec.ts` (local ports, ONE
  batched `GetUsersByIds`) and `apps/gateway/test/payment-user.e2e-spec.ts` (remote ports, ONE `GetUsersByIds` RPC).
- `presentation/grpc/billing-grpc.roundtrip.spec.ts` — `BillingApiModule.forRemote()` ↔ `BillingGrpcController`
  over real loopback gRPC: the remote adapter returns the local mapper's exact shape (int64 string, Date, absent
  optionals), webhook bytes arrive untouched, domain codes survive the hop.

Integration (Docker): `INTEGRATION=1 bunx vitest run --project billing:int` runs
`infrastructure/persistence/billing.migrations.int-spec.ts` on PostgreSQL 18 (testcontainers, or an
existing throwaway database via `INTEGRATION_DATABASE_URL`). It boots the real `DatabaseModule`, which
applies the platform set and billing's own history (schema `billing`), then checks the result: billing's
tables and enum in `billing` and none of identity's, nothing in `public`, one bookkeeping row per journal
entry in each set's own table, every index of the former migrations, the DB defaults (uuidv7 id, `pending`
status) and a second boot that applies nothing.

## Gotchas

- The webhook route's raw-body, `@Public()` and `@SkipRateLimit()` requirements: see **Stripe adapter** above.
- Stripe idempotency keys are account-wide, so the client `Idempotency-Key` is never forwarded verbatim; it is
  mapped per user to a payment id, and the Stripe key is `checkout-<paymentId>`.
- `billing.schema.ts` may only import `drizzle-orm` and dependency-free relative files (drizzle-kit loader).

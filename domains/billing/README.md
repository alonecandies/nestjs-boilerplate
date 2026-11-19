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
                   BillingPort, repository abstractions, mappers (contract, payment-succeeded payload)
  infrastructure/  billing.schema.ts (Drizzle), Drizzle repositories, billing's outbox (BillingOutbox, its system repository), local + gRPC port adapters, the Stripe adapter (stripe/)
  presentation/    REST BillingController, GraphQL BillingResolver, gRPC BillingGrpcController
  billing-core.module.ts · billing-grpc.module.ts · billing-api.module.ts
```

## Modules and wiring

| Module                         | Contents                                                                                                                                            | Used by          |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `BillingCoreModule`            | CQRS handlers, Drizzle repositories, billing's outbox and its relay (`OutboxModule.forFeature`), the Stripe adapter (`StripeModule.forRootAsync()`) | (via the others) |
| `BillingGrpcModule`            | `BillingCoreModule` + `BillingGrpcController` (`billing.v1.BillingService`)                                                                         | billing-service  |
| `BillingApiModule.forLocal()`  | `BillingController` + `BillingResolver` + `BillingPort → BillingLocalAdapter` (the app imports `BillingCoreModule` too)                             | monolith         |
| `BillingApiModule.forRemote()` | `BillingController` + `BillingResolver` + `BillingPort → BillingGrpcAdapter` + `GrpcClientsModule.register({ spec: BILLING_GRPC_PACKAGE, url })`    | gateway          |

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

| Method & path             | Auth                                                          | Input                                                                                                                                             | Response                                                                                                                       |
| ------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `POST /checkout-sessions` | Bearer, `billing:checkout`                                    | zod body `{ priceId: string(1..255), quantity?: int 1..100 = 1 }` (strict) + optional `Idempotency-Key` header (8–255 chars of `[A-Za-z0-9._:-]`) | `201 { id, url, paymentId }`                                                                                                   |
| `POST /webhooks/stripe`   | `@Public`, `@SkipRateLimit`, `Stripe-Signature`               | raw JSON body (verified byte-for-byte)                                                                                                            | `200 { received, eventId, eventType, duplicate }`                                                                              |
| `GET /payments`           | Bearer; `?all=true` needs `billing:read-all` (admins, owners) | zod query `{ all?: 'true'\|'false'\|'1'\|'0', limit?: 1..100 = 20, cursor?: string }`                                                             | `200 { items: Payment[], nextCursor: string \| null }` newest first, keyset-paginated (`amountTotal` = minor units, ISO dates) |

Errors are RFC 9457 `application/problem+json`: 400 (validation, `errors[]`), 401, 403, 409
(`IDEMPOTENCY_KEY_REUSED`, `PAYMENT_CONCURRENTLY_MODIFIED`, `CHECKOUT_IN_PROGRESS`, `CHECKOUT_SESSION_CLOSED`), 422 (`INVALID_WEBHOOK_SIGNATURE`,
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

`payments(all: true)` lists the active tenant and needs `billing:read-all` (admins, owners). N payments cost one batched user lookup, not N.
`amountTotal` is a `Float` holding integer minor units (GraphQL `Int` is 32-bit).

### gRPC (`billing.v1.BillingService`, billing-service)

| RPC                     | → bus                          | Notes                                                                                                                                                                                         |
| ----------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CreateCheckoutSession` | `CreateCheckoutSessionCommand` | zod-validated; optional `success_url`/`cancel_url` (internal callers only)                                                                                                                    |
| `HandleStripeWebhook`   | `HandleStripeWebhookCommand`   | `payload` is `bytes` (Buffer): the service verifies the signature                                                                                                                             |
| `ListPayments`          | `ListPaymentsQuery`            | `user_id` absent = every payment of `tenant_id` (the service recomputes `billing:read-all` from the caller's roles); `limit` 0 = 20; `cursor` in, `next_cursor` out (absent on the last page) |

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

| Stripe error                                               | DomainException                                               | `BillingErrorCode`              |
| ---------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------- |
| `StripeIdempotencyError`                                   | `DomainConflictException` (409)                               | `IDEMPOTENCY_KEY_REUSED`        |
| `StripeAPIError` with `code: idempotency_key_in_use` (409) | `DomainConflictException` (409, `details.retryAfterSec`)      | `CHECKOUT_IN_PROGRESS`          |
| `StripeCardError`                                          | `BusinessRuleViolationException` (422, `details.declineCode`) | `PAYMENT_DECLINED`              |
| `StripeInvalidRequestError`                                | `DomainValidationException` (422, issue at `param`)           | `PAYMENT_REQUEST_INVALID`       |
| `StripeRateLimitError`                                     | `ServiceUnavailableException` (503)                           | `PAYMENT_PROVIDER_RATE_LIMITED` |
| anything else from Stripe                                  | `ExternalServiceException` (502, generic message)             | `PAYMENT_PROVIDER_ERROR`        |

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
- `apiVersion` is pinned to `STRIPE_API_VERSION` (the SDK's literal, so an SDK upgrade that moves it fails `tsc`).
  Pin the webhook endpoint in the dashboard to the same version; events signed for another version are still
  applied but counted in `billing_stripe_api_version_mismatch_total`.
- `constructWebhookEvent` is synchronous on purpose (node:crypto HMAC is the cheapest path).
- The SDK keeps connections alive and retries 409/429/5xx/network errors, adding idempotency keys to retried
  POSTs; the handlers still pass their own business key (`checkout-<paymentId>`).
- Tests sign payloads with `Stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp? })`.

## Flows

**Checkout** (`CreateCheckoutSessionHandler`): insert a `pending` payment (or find the one this user's
`Idempotency-Key` already created in this tenant — unique `(tenant_id, user_id, idempotency_key)`; a different request, by `request_hash` over price, quantity, email and redirect URLs, is 409) →
`StripeService.createCheckoutSession` with Stripe idempotency key `checkout-<paymentId>`,
`client_reference_id = paymentId` and `metadata { paymentId, userId, tenantId }` (signed by Stripe, mirrored onto the PaymentIntent; the webhook resolves the tenant from it) → bind the session id, amount and currency
(optimistic lock on `version`). No transaction spans the Stripe call; every step is safe to repeat. A Stripe
failure marks the payment `failed`; a retry with the same key reopens it and gets the same session.

**Webhook** (`HandleStripeWebhookHandler`):

1. `StripeService.constructWebhookEvent(rawBody, signature)`: missing, forged or stale (> 5 min) signatures are a
   422 before any I/O.
2. `@Transactional()`: `INSERT INTO billing.stripe_events … ON CONFLICT (tenant_id, id) DO NOTHING` (tenant and user from the signed metadata via `stripeOwnerOf`; events without any, such as payouts, use the nil `PLATFORM_TENANT_ID` and a NULL user) — a duplicate delivery returns
   `duplicate: true` — then load the payment `FOR UPDATE` inside that tenant (by `client_reference_id`, else session id; an event naming another tenant finds nothing and is acknowledged) and apply:
   - `checkout.session.completed` / `async_payment_succeeded` (paid) → `succeeded` + `PaymentSucceededEvent`
     (a completed-but-`unpaid` session, i.e. a delayed payment method, stays `pending`);
   - `checkout.session.async_payment_failed` → `failed`; `checkout.session.expired` → `expired`;
   - any other signed event → acknowledged and ignored.
3. The whole delivery runs as the `{ userId, tenantId }` signed into the session and PaymentIntent metadata, so it can touch
   only that tenant's rows. An event without a usable owner (payouts, unattributed fees, pre-tenancy sessions) is recorded
   for the platform tenant through the `markProcessedAsPlatform` system method and nothing else.
4. In the same unit of work, after `markProcessed` and `save`, a completed payment enqueues
   `billing.payment-succeeded.v1` on `billing.outbox` (`BillingOutbox`). After COMMIT the aggregate's events go to
   the in-process event bus; the outbox relay publishes the row to Kafka.

Unknown payments and impossible transitions are acknowledged with a warning (a retry could never succeed).
A paid session with no usable currency (none in the event, none stored) is one of them: the payment stays
`pending` and is NOT announced (`billing.payment-succeeded.v1` requires an ISO 4217 code), the handler warns and
increments `billing_checkout_paid_without_currency_total` — alert on it and reconcile in the Stripe dashboard.
A paid session with no known amount is refused the same way and increments
`billing_checkout_paid_without_amount_total`. When Stripe charged an amount or currency other than
the stored quote (promotion codes, tax), the charged values are recorded and `billing_checkout_amount_mismatch_total`
increments.
Infrastructure errors propagate, the transaction rolls back (forgetting the event id) and Stripe's retry is
processed again. Old receipts are purged: see **Retention** below.

**Pagination.** `list` is keyset-paginated on the uuidv7 id (`@platform/database` `keysetFetchLimit`/`keysetPage`):
`WHERE tenant_id = $1 [AND user_id = $2] [AND id < $cursor] ORDER BY id DESC LIMIT n + 1` on
`payments_tenant_id_user_id_id_idx` (the whole-tenant listing uses the `(tenant_id, id)` primary key). Cursors are opaque; a forged one is a 422 `INVALID_CURSOR`, never SQL.

**Retention.** `PurgeStripeEventsCron` (hourly, `@WithLock('billing:purge-stripe-events')` so one replica runs
it) deletes `stripe_events` older than `STRIPE_EVENTS_RETENTION_DAYS` (30; Stripe redelivers for ≤ 3 days) via
`PurgeStripeEventsCommand`, in every tenant (the platform tenant included), in 15-minute time slices oldest first:
read `min(processed_at)`, one multi-shard `DELETE` up to it + 15 minutes (never reaching the cutoff), repeat, at most 96
per run, without a `LIMIT` subquery, which Citus cannot push down on a distributed table. Each slice stays far below
the role's `statement_timeout` (a timed-out one is retried at half the span), so a backlog drains over a few runs. It runs in `SystemContext` on the `app_system` pool (`DATABASE_SYSTEM_URL`; a system
method refuses outside the context). It needs `ScheduleModule.forRoot()` and `RedisModule` in the
app (billing-service and the monolith import both).

**Consistency.** `billing.payment-succeeded.v1` goes through a transactional outbox (`@platform/outbox`, G-1):
the webhook's unit of work inserts the row into `billing.outbox` (a plain `INSERT` as the signed owner: key = user
id, envelope id = the `PaymentSucceededEvent` id, `occurredAt` = `paidAt`, tenant and actor = the owner), so the
event commits or rolls back with the payment. A failing enqueue fails the delivery: no receipt, no transition,
and Stripe retries it. The outbox relay (one leader per process set, Redis lock `outbox-relay:billing`) polls the
table on the `app_system` pool, publishes each row with `KafkaProducer.publishStored` and marks it only after the
broker acknowledged it: delivery is at least once, and consumers dedupe on the stable envelope id. Nothing in
billing publishes to Kafka from a request path. `outbox.insertAsPlatform` is the only way a `PLATFORM_TENANT_ID`
row enters the table (the runtime policy refuses the nil tenant).

## Data model (`billingSchema`, `infrastructure/persistence/billing.schema.ts`)

| Table           | Columns                                                                                                                                                                                                                                                                                                                                                                                                                                        | Indexes                                                                                                                                                                                                                                                                                                                                                     |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `payments`      | `tenant_id uuid` (no FK: service boundary), `id uuid` (app uuidv7, DB default `uuidv7()`), `user_id uuid` (no FK), `price_id`, `quantity int`, `amount_total int8` (minor units, NULL until priced), `currency`, `status payment_status`, `stripe_checkout_session_id`, `stripe_payment_intent_id`, `idempotency_key`, `request_hash` (sha256 of the normalized request, NULL before B2), `paid_at`, `version int`, `created_at`, `updated_at` | PK `payments_tenant_id_id_pk (tenant_id, id)`; `payments_tenant_id_user_id_id_idx (tenant_id, user_id, id)` for "my payments in this tenant, newest first"; unique `payments_tenant_id_user_id_idempotency_key_uq (tenant_id, user_id, idempotency_key)`; unique `payments_tenant_id_stripe_checkout_session_id_uq (tenant_id, stripe_checkout_session_id)` |
| `stripe_events` | `tenant_id uuid`, `id text` (Stripe `evt_…`), `user_id uuid` (NULL for platform events), `type`, `processed_at`                                                                                                                                                                                                                                                                                                                                | PK `stripe_events_tenant_id_id_pk (tenant_id, id)` = the idempotency key; `stripe_events_processed_at_idx` for the retention purge                                                                                                                                                                                                                          |

Both tables are distributed by `tenant_id` on Citus, colocated with `app.tenant_colocation` (and so with identity's
tenant tables): `0002_distribute.sql` (SH-6). The primary key and every unique index start with `tenant_id`, and no
FK reaches another domain, so a query by `(tenant_id, …)` goes to one shard. Rows created before B2 belong to the platform tenant (nil
UUID): no tenant can list them.

### Ledger tables (`0005_ledger_tables.sql`, outbox plan Task 10, ledger design §5)

The receipts and bookkeeping around the immudb ledger (the entries themselves live in immudb). Every table also has
`created_at`; no FK (`payment_id`, `run_id` and `resolves_id` are plain columns); all five have RLS enabled and forced.
T = distributed by `tenant_id` inline, right after its `CREATE TABLE`, colocated with `app.tenant_colocation`;
L = coordinator-local, system only.

| Table (kind)                     | Columns                                                                                                                                                                                | PK                            | Grants `app_runtime` / `app_system` |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ----------------------------------- |
| `ledger_accounts` (T)            | `tenant_id`, `code`, `currency`, `immudb_account_id uuid`                                                                                                                              | `(tenant_id, code, currency)` | S, I / S, I                         |
| `ledger_entry_refs` (T)          | `tenant_id`, `entry_id`, `source_key`, `payload_hash`, `immudb_tx_id int8` (NULL when replayed), `payment_id` (nullable), `kind`, `posted_at`; index `ledger_entry_refs_posted_at_idx` | `(tenant_id, entry_id)`       | S, I / S, I                         |
| `ledger_discrepancies` (T)       | `tenant_id`, `id`, `kind`, `source_key`, `expected jsonb`, `actual jsonb`, `detected_by`, `run_id` (nullable), `resolves_id` (nullable)                                                | `(tenant_id, id)`             | S, I / S, I                         |
| `ledger_reconciliation_runs` (L) | `id`, `from_ts`, `to_ts`, `status`, `counts jsonb`, `finished_at` (nullable)                                                                                                           | `(id)`                        | none / S, I, U                      |
| `ledger_trusted_state` (L)       | `database`, `tx_id int8`, `tx_hash bytea`, `verified_at`                                                                                                                               | `(database)`                  | none / S, I, U                      |

- Each tenant table has two policies `TO app_runtime`: `<table>_select USING (tenant_id = app.tenant_id() AND
app.elevated())` and `<table>_insert WITH CHECK (tenant_id = app.tenant_id())`. A principal inserts only its own
  tenant's rows and reads them only when elevated (the posting consumer's `roles: []` principal never is), so its
  inserts are plain `INSERT`s without `RETURNING`. An idempotent runtime insert uses `INSERT … ON CONFLICT DO
NOTHING` without a conflict target: the int spec pins that it reports 1 row, then 0, for a non-elevated principal
  on Citus.
- Neither app role may `UPDATE` or `DELETE` a tenant table: entry refs and discrepancies are append-only.
  `PLATFORM_TENANT_ID` rows and the two local tables belong to `app_system`.

### Row-level security (`0003_rls.sql`, B3-5/B3-6, program spec §8.2)

Both tables have RLS enabled and **forced** (the owner `app_owner` has no policy, so it reads and writes no row).
Grants are explicit per table and role, deny by default; `billing.__drizzle_migrations` has no RLS and no grant to
either app role. Policies are `TO app_runtime` and call `app.tenant_id()`, `app.user_id()` and `app.elevated()`
directly (no subquery, no helper or FK into identity); "–" means no policy, so denied:

| Table (grants to `app_runtime`) | SELECT `USING`                                                                | INSERT `WITH CHECK`                                       | UPDATE `USING` / `WITH CHECK` | DELETE |
| ------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------- | ------ |
| `payments` (S, I, U)            | `tenant_id = app.tenant_id() AND (user_id = app.user_id() OR app.elevated())` | `tenant_id = app.tenant_id() AND user_id = app.user_id()` | same as INSERT (both)         | –      |
| `stripe_events` (S, I)          | `tenant_id = app.tenant_id() AND user_id = app.user_id()`                     | same as SELECT                                            | –                             | –      |

- Elevation (`billing:read-all`) widens the payments read to the tenant; it never writes another member's payment,
  and a `SELECT … FOR UPDATE` of another member's payment returns nothing even when elevated.
- `app_system` (BYPASSRLS) gets `SELECT, INSERT, DELETE` on `stripe_events` (the Stripe-event system methods) and,
  since `0006_ledger_system_reads`, `SELECT` on `payments` (reconciliation R3's
  `ledgerReconciliation.listSucceededPayments`); it never writes a payment. Rows with `tenant_id = PLATFORM_TENANT_ID` match no runtime policy: only `app_system`
  reads or writes them.
- **Which principal each flow runs as** (no transaction spans the Stripe call, and each flow settles its principal before
  its unit of work opens):

  | Flow                                 | Runs as                                                                                                                                                |
  | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
  | Webhook, owner with tenant and user  | `runWithPrincipal({ userId, tenantId, roles: [] })` from the signed metadata, around one `@Transactional()` unit (`markProcessed`, payment lock, save) |
  | Webhook, platform or user-less owner | `SystemContext.run('billing.platform-webhook')` and `stripeEvents.markProcessedAsPlatform` only: no runtime transaction, no payment looked up          |
  | Create checkout session              | the request principal; each repository call is its own unit of work, and no transaction spans the Stripe call                                          |
  | List payments                        | the request principal; the `billing:read-all` check is in TypeScript first, then `elevate(billing:read-all)` for the whole-tenant listing only         |
  | Purge Stripe events (hourly cron)    | `SystemContext.run('billing.purge-stripe-events')` and `stripeEvents.deleteProcessedBefore`                                                            |

- **System methods** (all `system` scope, pinned in `billing.system-methods.ts`):
  `stripeEvents.deleteProcessedBefore` and `stripeEvents.markProcessedAsPlatform`; the four shared `outbox.*`
  methods; and the ledger's ten (outbox plan Task 11, spec §9 items 9-11 and delta 4):
  `ledgerReconciliation.{listSucceededPayments, listEntryRefs, appendDiscrepancies, enqueueMissingPostings}`,
  `ledgerEntryRefs.recordAsSystem`, `ledgerAccounts.recordPlatformAccounts`, `ledgerTrustedState.{read, advance}` and
  `ledgerRuns.{start, finish}`. Only the three `drizzle-*.system-repository.ts` files name `SystemDatabase`. Every
  process that runs the billing core needs `DATABASE_SYSTEM_URL`; without it a platform webhook fails with
  `SYSTEM_DATABASE_UNAVAILABLE` and Stripe retries.

`payment_status` enum: `pending`, `succeeded`, `failed`, `expired`, `refunded`, `partially_refunded`, `disputed`.
Constraint and index names are explicit snake_case (`payments_tenant_id_id_pk`). The tables and the enum live in the `billing` Postgres schema
(`billingPgSchema`); raw SQL qualifies them (`billing.payments`). Billing owns its migration history:
`drizzle.config.ts` generates `src/infrastructure/persistence/migrations` (`0000_init.sql` holds the original tables and
indexes; `0001_tenant_columns.sql` adds the tenant columns, the tenant-leading keys and the three ledger statuses;
`0002_distribute.sql` is hand-written and only calls `app.distribute_by_tenant` on both tables; a table added later
calls it right after its `CREATE TABLE`), bookkeeping in `billing.__drizzle_migrations`, and
`billingMigrations` applies it after the platform set (the schema file imports only `drizzle-orm` and a
dependency-free enum file, so drizzle-kit can load it). Every query carries `tenant_id` (`findById(tenantId, id)`, `findForCheckoutSession({ tenantId, … })`, `list({ tenantId, … })`).
Every repository method runs in `inUnitOfWork` (`@platform/database`): it joins the active transaction or opens one that starts
with the principal's `SET LOCAL` context. There is no pool handle and no prepared statement, because a statement outside a
transaction would carry no RLS context.

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
  infrastructure error, events published only after the transaction, the outbox record enqueued after
  `markProcessed` and `save` and before COMMIT, nothing enqueued otherwise, a failing enqueue rolling back), list
  (limit normalisation).
- Mappers (contract, row, the payment-succeeded payload), local adapter (bus mapping), gRPC
  adapter (null normalisation, metadata, error mapping), gRPC controller (bus mapping, zod payload schemas).
- Drizzle repositories: real Drizzle SQL generation on a recording postgres.js fake (ON CONFLICT targets,
  `FOR UPDATE`, optimistic lock, prepared list statements).
- `billing.migrations.spec.ts` — the migration set: its folder and `billing.__drizzle_migrations` bookkeeping,
  every table and enum in the `billing` schema, the match with `drizzle.config.ts`, the baseline's
  `CREATE SCHEMA IF NOT EXISTS "billing";` first statement, `0002_distribute` holding only the two
  `app.distribute_by_tenant` calls, and `0003_rls` holding exactly the forced RLS, the five policies (no subquery)
  and one grant per table and role, `0004_outbox` holding the plan's outbox SQL in order
  (`describeOutboxTable` pins the table's shape), and `0005_ledger_tables` holding the five ledger tables in order
  (each tenant table's distribution call right after its `CREATE`, no FK, no `REVOKE`, the contract's grants and
  policies), and `0006_ledger_system_reads` holding only `app_system`'s `SELECT` on `payments`.
- `infrastructure/stripe/*.spec.ts` — the Stripe adapter: SDK error mapping, signature verification (valid, forged, stale, re-serialised, missing, not JSON), Checkout params and idempotency key, module wiring and the invalid-key boot failure.
- `billing.controller.spec.ts` — Fastify app with the real `AuthModule` guards (tokens from `signTestAccessToken`, `@platform/auth/testing`):
  401/403, 400 validation (body, query, `Idempotency-Key`), serialisation, raw-body webhook, OpenAPI document.
- `billing.resolver.spec.ts` — Apollo on Fastify: payments (owner as `userId`; billing defines no `user` field), RBAC, input validation.
- `test/stripe-webhook.flow.spec.ts` — raw body → controller → local adapter → handler → outbox (in memory) → one
  relay tick → Kafka fake.
- `billing.modules.spec.ts` — DI wiring of `BillingGrpcModule`, `BillingApiModule.forLocal()` / `.forRemote()`.
- `Payment.user` is tested where it is composed: `apps/monolith/test/payment-user.e2e-spec.ts` (local ports, ONE
  batched `GetUsersByIds`) and `apps/gateway/test/payment-user.e2e-spec.ts` (remote ports, ONE `GetUsersByIds` RPC).
- `presentation/grpc/billing-grpc.roundtrip.spec.ts` — `BillingApiModule.forRemote()` ↔ `BillingGrpcController`
  over real loopback gRPC: the remote adapter returns the local mapper's exact shape (int64 string, Date, absent
  optionals), webhook bytes arrive untouched, domain codes survive the hop.

Integration (Docker): `INTEGRATION=1 bunx vitest run --project billing:int` runs every spec on a fresh Citus 14.2 container
from `startRlsTestPostgres()` (the three roles, `citus.enable_local_execution=off`; `INTEGRATION_DATABASE_URL` is not
used). The harness `test/billing-database.ts` (`startBillingDatabase`) boots the real `DatabaseModule` with the roles of
production: migrations as `app_owner` on `DATABASE_MIGRATION_URL`, the app as `app_runtime` on `DATABASE_URL`, system
methods as `app_system` on `DATABASE_SYSTEM_URL`, and the boot guard in `enforce`; seeding and assertions past RLS go
through its `superuser` handle.
`infrastructure/persistence/billing.migrations.int-spec.ts` applies the platform set and billing's own history (schema
`billing`), then checks the result: billing's tables and enum in `billing` and none of identity's, nothing in `public`,
one bookkeeping row per journal entry in each set's own table, every index of the former migrations, the DB defaults
(uuidv7 id, `pending` status) and a second boot that applies nothing.
`infrastructure/persistence/billing.repositories.int-spec.ts` runs the repositories as `app_runtime` (`startBillingDatabase`):
tenant isolation of list, find and lock, Idempotency-Keys per (tenant, user), platform events with a NULL user, and
migration `0001` applied to a database that already has rows.
`test/billing-flows.rls.int-spec.ts` (13 cases) runs the real billing core on the three URLs and proves each flow of the
table above: `current_user` is `app_runtime`; a signed webhook updates only its tenant's payment and a replay changes
nothing; metadata naming another tenant's payment touches neither tenant; a malformed tenant id is recorded as a platform
event through `markProcessedAsPlatform` with no runtime transaction; a failing save rolls the receipt back and the retry
applies it; checkout calls Stripe with no applied RLS context; a member lists only their own payments, an admin lists the
tenant's (elevated, ending with the transaction); the purge deletes the old events of every tenant and the platform
tenant. Across the file the system methods used are exactly the two pinned ones (the outbox relay is off there:
`OUTBOX_RELAY_ENABLED=false`).
`infrastructure/persistence/billing.distribution.int-spec.ts` (`startRlsTestPostgres()`: local execution off, the
history applied as `app_owner`): both tables distributed by `tenant_id` and colocated with `app.tenant_colocation`,
`0002` re-applied without change, the purge removing exactly the old events of tenants on every shard and of the
platform tenant, both `payments` uniques per tenant, and a `(tenant_id, id)` router query (data through the
superuser, since forced RLS hides every row from the owner).
`infrastructure/persistence/billing.rls.int-spec.ts` (`startRlsTestPostgres()`, migrated as `app_owner`, seeded as the
superuser, every case as raw postgres.js `app_runtime` in a transaction opened with `buildRlsContextSql`): both
paths of every policy with exact rows (own payments only; elevated reads the tenant's, never another tenant's, and
never updates another member's payment; inserts and updates only for the current tenant and user; `FOR UPDATE`;
own Stripe events only, UPDATE and DELETE `42501`), platform rows invisible to every runtime principal and readable
by `app_system`, no context returning or changing nothing, forced RLS (the owner reads nothing), the exact grants and
policies, and nothing on `billing.__drizzle_migrations`. A superuser snapshot after every case proves that no
forbidden write changed a row.
`infrastructure/persistence/billing.outbox.rls.int-spec.ts` (`0004_outbox`, local execution off): `billing.outbox`
distributed by `tenant_id` and colocated, RLS enabled and forced, exactly `INSERT` for `app_runtime` and `SELECT,
INSERT, UPDATE, DELETE` for `app_system`, the one `outbox_insert` policy; a principal inserts only its own tenant's
rows (another tenant's, the nil tenant's and a tenant-less principal's are refused); runtime reads and writes are
`42501`; the system repository polls and marks; a row written by `insertAsPlatform` is invisible to and unchangeable
by every runtime principal, elevated or not, and is returned by the poll.
`infrastructure/persistence/billing.ledger.rls.int-spec.ts` (`0005_ledger_tables`, local execution off): the three
tenant tables distributed by `tenant_id` and colocated, the two local ones not in `pg_dist_partition`; forced RLS and
no FK on all five; exactly the contract's grants and policies. Per tenant table: a non-elevated member inserts its
own tenant's row, another tenant's or the nil tenant's is refused; it reads nothing without elevation and only its
tenant's rows with it (never another tenant's or the platform's, which `app_system` reads); `UPDATE` and `DELETE`
are `42501` for `app_runtime`, elevated or not, and for `app_system`. Local tables: runtime `SELECT` and `INSERT` are
`42501`, `app_system` inserts, reads and updates. The probe for the receipts repository: `INSERT … ON CONFLICT DO
NOTHING` (no target, no `RETURNING`) on `ledger_entry_refs` as a non-elevated member reports 1 row, then 0. Without
an RLS context nothing is readable.
`infrastructure/persistence/billing.ledger-repositories.rls.int-spec.ts` (outbox plan Task 11, local execution off):
the receipts repository as a non-elevated member (`recordEntryRef` true then false, another tenant's or the
platform's ref `42501`, `recordAccounts` idempotent and refusing platform-owned rows before SQL, `appendDiscrepancy`
true then false, no principal refused before BEGIN) and the ledger system repository as `app_system` (both lists
return every tenant's rows, the platform's included, in `(tenant_id, id)` order over three pages within `[from, to)`;
`appendDiscrepancies`, `enqueueMissingPostings`, `recordEntryRefs` and `recordPlatformAccounts` count new rows only;
the trusted-state compare-and-set; a run finishes once; every method refused outside `SystemContext`).
`test/webhook-outbox.int-spec.ts` (the real core on the three URLs, the module's relay off): a paid webhook for tenant
A leaves the payment succeeded, the receipt and one outbox row under A; a replay adds no row; one tick of a real
`OutboxRelay` publishes an envelope that parses with `PAYMENT_SUCCEEDED_EVENT` and marks the row; with the row's id
pre-seeded through the system pool, the delivery fails and leaves the payment pending and no receipt.

## Ledger (immudb)

An append-only double-entry ledger in immudb (`@platform/immudb`), not Postgres. One entry per Stripe
balance transaction (`sourceKey = stripe:txn:<id>`, entry id = uuidv5 of it), postings in minor units per
currency, fees from the balance transaction (`application/ledger/posting-rules.ts`). `LedgerPort.post` is
idempotent (`posted` / `replayed` / `conflict`) and validates the double-entry rules before any I/O. The
immudb user may only `SELECT` and `INSERT`; every tenant read carries `tenant_id = @tenant` (immudb has no
RLS). Tables: `infrastructure/ledger/migrations/001_ledger.sql` (`billingLedgerMigrations`). Not wired
into the apps yet: the posting consumer, reconciliation and `LEDGER_ENABLED` arrive with the outbox
(ledger waves 1-2). Tests: `InMemoryLedger` (`@domain/billing/testing`) and the adapter run the same
contract spec (`src/testing/ledger.contract.test.ts`).

Postgres keeps the receipts around the entries (outbox plan Task 11): `LedgerReceiptsRepository` writes refs, tenant
account rows and findings as the principal (plain `INSERT … ON CONFLICT DO NOTHING`, no target and no `RETURNING`,
the form 0005's probe pinned), and `LedgerSystemRepository` is the system side (reconciliation lists, findings,
re-enqueued postings, platform refs and accounts, the trusted state and the runs). Findings have deterministic ids
(`ledgerDiscrepancyId`: kind, source key and a hash of `expected`/`actual`), so an overlapping window or a rerun
appends nothing new. `InMemoryLedgerStore` (`@domain/billing/testing`) is the twin of both.

## Gotchas

- The webhook route's raw-body, `@Public()` and `@SkipRateLimit()` requirements: see **Stripe adapter** above.
- Stripe idempotency keys are account-wide, so the client `Idempotency-Key` is never forwarded verbatim; it is
  mapped per user to a payment id, and the Stripe key is `checkout-<paymentId>`.
- `billing.schema.ts` may only import `drizzle-orm` and dependency-free relative files (drizzle-kit loader).

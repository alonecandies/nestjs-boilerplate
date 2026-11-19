# billing-service

The billing bounded context as a standalone microservice: Stripe Checkout sessions, exactly-once
Stripe webhooks and the payments ledger in Postgres. It serves **gRPC only**; the gateway exposes
`/v1/billing/*` and GraphQL through `BillingApiModule.forRemote()`, receives the Stripe webhook
with its raw body and forwards the exact bytes plus `Stripe-Signature` here, where the signature is
verified.

| Surface | Port (default)             | What                                                                           |
| ------- | -------------------------- | ------------------------------------------------------------------------------ |
| gRPC    | `GRPC_URL` `0.0.0.0:50053` | `billing.v1.BillingService`, health, reflection                                |
| HTTP    | `PORT` `3003`              | `GET /health/live`, `GET /health/ready`, `GET /metrics` only                   |
| Kafka   | produces                   | `billing.payment-succeeded.v1` (key `userId`; envelope id = domain event id)   |
| Kafka   | consumes (ledger on)       | `billing.ledger-posting.v1` in group `billing-service` (`LEDGER_ENABLED=true`) |

The domain logic lives in [`@domain/billing`](../../domains/billing); this app is only the composition
root.

## Composition (`src/app.module.ts`)

| Module                                                                                                                                                             | Why                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `AppConfigModule.forRoot()` + `ConfigModule.forFeature(grpcConfig)`                                                                                                | `app`/`observability` + the gRPC bind namespace, validated at boot                                                                  |
| `ObservabilityModule.forRoot({ healthContributors: [postgres, redis] })`                                                                                           | pino JSON logs, request context, `/metrics`, `/health/*`; Kafka is not a readiness dependency (best-effort events)                  |
| `CqrsModule.forRoot()`                                                                                                                                             | command/query buses, `EventPublisher` (events published after COMMIT)                                                               |
| `ScheduleModule.forRoot()`                                                                                                                                         | runs `PurgeStripeEventsCron` (hourly `stripe_events` retention, one replica via `@WithLock`)                                        |
| `DatabaseModule.forRootAsync({ schema: billingSchema, migrations: DATABASE_MIGRATIONS })`                                                                          | Drizzle + postgres.js pool, the transactional CLS plugin behind `@Transactional()`, migrations                                      |
| `RedisModule.forRootAsync()`                                                                                                                                       | readiness + the distributed lock of `PurgeStripeEventsCron`                                                                         |
| `KafkaProducerModule.forRootAsync()`                                                                                                                               | idempotent producer for the `billing.outbox` relay (`OutboxRelay`, `@platform/outbox`)                                              |
| `BillingGrpcModule`                                                                                                                                                | `BillingCoreModule` (with its Stripe adapter: client, retries, timeout, webhook signature verification) + `BillingGrpcController`   |
| `provideCommonEnhancersAsync(...)`, `CorrelationIdMiddleware`                                                                                                      | problem+json on the ops port; with `inheritAppConfig` the enhancers wrap gRPC too                                                   |
| `LEDGER_ENABLED=true` only: `ImmudbModule.forRootAsync({ migrations: [billingLedgerMigrations] })`, `BillingMessagingModule`, `ImmudbHealthIndicator` in readiness | the immudb ledger: `LedgerPort` bound to `ImmudbLedgerAdapter`, the `billing.ledger-posting.v1` consumer, immudb in `/health/ready` |

`main.ts`: `createServiceApp(AppModule)` → `connectGrpcServer(app, [BILLING_GRPC_PACKAGE])` →
`connectLedgerConsumer(app, ledgerConfig.parse())` → `startAllMicroservices()` → `listen(app)`.
The ledger consumer is the service's first Kafka consumer: with `LEDGER_ENABLED=true` it calls
`connectKafkaConsumer(app, { groupId: BILLING_CONSUMER_GROUP })` (`'billing-service'`, fixed in
`src/billing-service.constants.ts`); with the default `false` the service joins no group, loads no
immudb client and boots without immudb. `AppModule` is `createAppModule()` evaluated against the
process env, so `LEDGER_ENABLED` is read once, when the module is defined.

| RPC                                    | Dispatches                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `BillingService.CreateCheckoutSession` | `CreateCheckoutSessionCommand` (pending row first, Stripe idempotency key `checkout-<paymentId>`)            |
| `BillingService.HandleStripeWebhook`   | `HandleStripeWebhookCommand` (verify → one transaction: `stripe_events` insert-or-skip + payment transition) |
| `BillingService.ListPayments`          | `ListPaymentsQuery` (`user_id` absent = all, for admins; the gateway enforces RBAC)                          |

A forged or stale signature is `INVALID_ARGUMENT` with `x-error-code: INVALID_WEBHOOK_SIGNATURE`;
database failures are `INTERNAL` with the message hidden (the gateway maps them to 502).

## Configuration

`.env.example` holds only what differs per service; `bun run setup:env` copies it to `.env`.
Everything else comes from the root `.env` / the environment ([`@platform/config`](../../libs/config)):

| Variable                                     | Value here               | Notes                                                                             |
| -------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------- |
| `SERVICE_NAME`                               | `billing-service`        | log `service`, Kafka client id, envelope `source`                                 |
| `PORT` / `GRPC_URL`                          | `3003` / `0.0.0.0:50053` | the gateway dials `BILLING_GRPC_URL`                                              |
| `KAFKA_GROUP_ID`                             | `billing-service`        | the ledger consumer joins the fixed group `billing-service` regardless            |
| `LEDGER_ENABLED`                             | root `.env` (`false`)    | `true`: immudb, the ledger-posting consumer, immudb in readiness                  |
| `IMMUDB_*`                                   | root `.env`              | read only with the ledger on; `IMMUDB_RUN_MIGRATIONS` migrates the ledger at boot |
| `DATABASE_RUN_MIGRATIONS`                    | `true`                   | advisory-locked: the platform set, then billing's own history (schema `billing`)  |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | secret store             | placeholders by default: checkout fails, webhooks are rejected                    |
| `STRIPE_SUCCESS_URL`, `STRIPE_CANCEL_URL`    | root `.env`              | defaults for requests without their own URLs                                      |
| `DATABASE_URL`, `REDIS_URL`, `KAFKA_BROKERS` | root `.env`              |                                                                                   |

## Running

```bash
bun run docker:infra                                  # Postgres, Redis, Kafka (+ topics)
bun run dev:billing                                   # node --watch on the TS sources (no build)
bun run --filter @app/billing-service build           # SWC → dist/
bun run --filter @app/billing-service start           # node --import ./dist/instrument.js dist/main.js
bun run --filter @app/billing-service db:migrate      # Postgres; with LEDGER_ENABLED=true also immudb
```

`src/migrate.ts` applies the Postgres history and then, with `LEDGER_ENABLED=true` and only when
Postgres succeeded, `runImmudbMigrationsCli([billingLedgerMigrations])` (provisions the immudb
database and its SELECT + INSERT-only user; needs `IMMUDB_ADMIN_PASSWORD`).

`src/instrument.ts` is preloaded (`--import`) by `start` (from `dist/`) and by `bun run dev` (from
the TS sources, after the swc-node loader), so tracing works in the dev loop too; it is a no-op
without an OTLP endpoint.

Scaffold providers/controllers with `bun run g <schematic> <name>` from this folder (e.g.
`bun run g service foo`): it runs `nest g` and then `eslint --fix src`, because the Nest
schematics import `TestingModule` as a value and `consistent-type-imports` would fail
`bun run check`.

## Boot, degradation and shutdown

Measured with the dist entrypoint (`NODE_ENV=production`) against throwaway containers, except the
row marked _by design_:

| Situation                                                                  | Behaviour                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Nothing reachable                                                          | **fails fast**: the boot-time migration lock gets `ECONNREFUSED`, one `fatal` log, exit code 1 after ~2 s                                                                                                                                                                                                                                                                                        |
| Redis down (_by design_)                                                   | fails fast after `REDIS_CONNECT_TIMEOUT_MS` (10 s)                                                                                                                                                                                                                                                                                                                                               |
| **Kafka down**, Postgres + Redis up (_by design_, covered by the e2e spec) | **boots degraded and stays ready**: gRPC works (listing, webhook verification), `/health/ready` is 200 (Kafka is not a readiness contributor: publishing is best-effort, so a broker outage must not pull every replica out of rotation); the `billing.payment-succeeded.v1` events of that window wait in `billing.outbox` and the relay publishes them once the broker is back (at least once) |
| `SIGTERM`                                                                  | gRPC `NOT_SERVING` → HTTP + gRPC drain (an in-flight webhook transaction commits) → Postgres, Redis, Kafka closed → exit 0 in ~1 s                                                                                                                                                                                                                                                               |

## Tests

```bash
bunx vitest run --project billing-service --project billing-service:e2e
```

- `test/app.e2e-spec.ts` boots the **real `AppModule`** with fakes only at the network edges: a real
  drizzle instance over a fake postgres.js client (with `begin()` for `@Transactional()`),
  `InMemoryRedis` and `FakeKafkaProducer`; Stripe is never called. It checks `/health/live`,
  `/metrics`, `/health/ready` (exactly postgres/redis, 200 while `KAFKA_BROKERS` is unreachable),
  that there is no HTTP webhook route, and real gRPC round trips from a gateway-style
  `ClientGrpcProxy`: `ListPayments` (int64 → string,
  Timestamp → `Date`, unpriced payment), `INVALID_ARGUMENT` before any SQL, a database failure →
  `INTERNAL` without leaking the host, `HandleStripeWebhook` with a genuinely signed event
  (`BEGIN` → `stripe_events` insert → `COMMIT`, the redelivery acknowledged as a duplicate) and a
  forged signature → `INVALID_WEBHOOK_SIGNATURE` with no SQL. With the default env it pins that no
  immudb client or ledger consumer exists and no Kafka consumer is connected; a second suite boots
  `createAppModule()` with `LEDGER_ENABLED=true` and a `RecordingImmudbClient`: one Kafka consumer
  in group `billing-service` carrying the `billing.ledger-posting.v1` handler, `LedgerPort` on the
  immudb adapter, and `immudb` in `/health/ready`.
- `test/env-example.spec.ts` validates `.env.example` and pins the ports.

No Docker is needed.

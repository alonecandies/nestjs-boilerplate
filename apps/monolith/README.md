# @app/monolith

The **modular monolith**: every bounded context (identity, notifications, billing, files) runs in
one Node process. It serves the same edge API as the [gateway](../gateway/README.md) — the same
controllers, resolvers, Socket.IO gateway and Kafka consumers — but every port is bound to a
**local adapter** (`XApiModule.forLocal()` → `CommandBus` / `QueryBus`), so a request never
leaves the process. Kafka still carries the asynchronous integration events, exactly as between
the microservices, which is what makes "monolith first, split later" a wiring change instead of a
rewrite.

```
HTTP :3000 (Fastify) ──► REST /v1 · GraphQL /graphql · Socket.IO /notifications · /docs · /health · /metrics
        │ ports → local adapters (CQRS buses)
        ▼
identity core ── Postgres (drizzle)        billing core ── Postgres (drizzle) + Stripe
notifications core ── Cassandra + BullMQ mail worker (SMTP)
        │ integration events (Kafka, consumer group `monolith`)
        └─► identity.user-registered.v1 → welcome notification + mail
            billing.payment-succeeded.v1 → receipt notification + mail
            notifications.notification-created.v1 → Socket.IO room user:{id} + GraphQL subscription
```

## Run it

```bash
bun run setup            # install + copy every .env.example to .env (never overwrites)
bun run docker:infra     # local infrastructure from the root docker-compose.yml
bun run dev:monolith     # = `bun run dev` — node --watch on the TS sources (no build step)
```

The dev loop runs straight from the sources of the app and every lib (`@app/source` export
condition + `@swc-node/register`): an edit in `libs/**` restarts the process too.

Production build and start (what the Docker image runs):

```bash
bun run --filter @app/monolith build   # swc → apps/monolith/dist (libs are built by `bun run build`)
cd apps/monolith && bun run start      # node --import ./dist/instrument.js dist/main.js
```

`dist/instrument.js` is preloaded (`src/instrument.ts` under `bun run dev`) so OpenTelemetry hooks
the modules before they are imported (a no-op unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set).
`CLUSTER_WORKERS=N` (0 = one per core) runs N workers under a supervising primary; keep 1 under
Kubernetes and scale pods instead.

Scaffold providers/controllers with `bun run g <schematic> <name>` from this folder (e.g.
`bun run g service foo`): it runs `nest g` and then `eslint --fix src`, because the Nest
schematics import `TestingModule` as a value and `consistent-type-imports` would fail
`bun run check`.

## Environment

App-specific overrides live in [`.env.example`](./.env.example); everything else has working
defaults for the local docker-compose infra in `libs/config` (see the root README).

| Variable                   | Default          | Purpose                                                                  |
| -------------------------- | ---------------- | ------------------------------------------------------------------------ |
| `SERVICE_NAME`             | `app`            | logs, metrics, Kafka client id, Redis connection names → set it          |
| `PORT` / `HOST`            | `3000` / 0.0.0.0 | HTTP listener                                                            |
| `KAFKA_GROUP_ID`           | `monolith`       | consumer group of the in-process consumers (shared by all replicas)      |
| `DATABASE_RUN_MIGRATIONS`  | `false`          | apply the drizzle migrations at boot (advisory-locked)                   |
| `CASSANDRA_RUN_MIGRATIONS` | `true`           | apply the CQL migrations at boot (LWT-claimed)                           |
| `CLUSTER_WORKERS`          | `1`              | node:cluster workers (`0` = per core)                                    |
| `DOCS_ENABLED`             | not in prod      | `/docs`, `/openapi.json`, `/openapi.yaml`                                |
| `MAINTENANCE_MODE`         | `false`          | every route except `/health*` and `/metrics` answers 503 + `Retry-After` |

The Kafka topics (and their `.dlq`) must exist — auto-creation is off: `identity.user-registered.v1`,
`billing.payment-succeeded.v1`, `notifications.notification-created.v1`.

## Endpoints

| Surface  | Where                                                                                                                                                                                                                                                                                                                                  |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ops      | `GET /health/live`, `GET /health/ready` (postgres, cassandra, redis — not Kafka: events are best-effort, a broker outage must not take the API out of rotation), `GET /metrics`, `GET /docs` (Scalar), `GET /openapi.json`, `GET /openapi.yaml`                                                                                        |
| Identity | `POST /v1/auth/register`, `POST /v1/auth/login`, `POST /v1/auth/refresh`, `POST /v1/auth/logout`, `GET /v1/auth/me`, `GET /v1/users`, `GET /v1/users/:id`, `PATCH /v1/users/:id/roles`                                                                                                                                                 |
| Notifs   | `GET /v1/notifications`, `POST /v1/notifications/:id/read`; Socket.IO namespace `/notifications` (`auth: { token }`, websocket transport)                                                                                                                                                                                              |
| Billing  | `POST /v1/billing/checkout-sessions`, `POST /v1/billing/webhooks/stripe` (raw body, signature-verified), `GET /v1/billing/payments`                                                                                                                                                                                                    |
| Files    | `POST /v1/files` (streaming multipart), `POST /v1/files/presigned-uploads`, `GET /v1/files/download-url`, `DELETE /v1/files`                                                                                                                                                                                                           |
| GraphQL  | `POST /graphql` (Apollo Sandbox in dev): `me`, `user`, `users`, `notifications`, `payments`; mutations `register`, `login`, `refreshTokens`, `updateUserRoles`, `markNotificationRead`, `createCheckoutSession`, `createUploadUrl`; subscription `notificationCreated` (graphql-ws, `connectionParams: { authorization: 'Bearer …' }`) |

Errors are RFC 9457 `application/problem+json` (`type`, `title`, `status`, `detail`, `code`,
`requestId`, `errors[]`); every response carries `x-request-id` and `x-correlation-id`.

`/metrics`, `/docs` and `/openapi.*` share the API port: don't route them through the public ingress
(set `METRICS_BEARER_TOKEN` for scrapes; see docs/DOCKER.md).

## How it is wired

- `src/app.module.ts` — import order is deliberate: config → observability → CQRS/schedule →
  data stores → Redis/cache → `AuthModule` **before** `AppThrottlerModule` (global guards run in
  registration order; the throttler tracks by user) → queue/mailer/Kafka/Stripe/storage →
  GraphQL + Redis PubSub → the domain modules. The `Api` modules import their `Core` module; never
  import a Core module a second time. Root providers: `provideCommonEnhancersAsync` (both
  validation pipes, the problem+json filter, the handler timeout); root middleware:
  `CorrelationIdMiddleware`, `MaintenanceModeMiddleware`.
- `src/main.ts` — `runClustered` → `createHttpApp(AppModule, { rawBody, multipart })` → Redis
  Socket.IO adapter → `connectKafkaConsumer` (hybrid app, `inheritAppConfig`) → `setupApiDocs` →
  `startAllMicroservices` → `listen`.
- **Startup is fail-fast.** Redis must answer within `REDIS_CONNECT_TIMEOUT_MS`, Postgres and
  Cassandra are retried briefly, and the Kafka consumer must connect; otherwise the process logs
  one `fatal` line and exits 1 (verified against no infrastructure: Postgres unreachable → exit 1
  after ~7 s). Once running, dependencies degrade per request (readiness turns 503 for Postgres,
  Cassandra or Redis, calls fail as problem+json) and reconnect on their own; a Kafka outage keeps
  the app ready and only delays or drops integration events (logged, no outbox yet).
- **Shutdown** (SIGTERM/SIGINT): Fastify stops accepting, in-flight requests and Kafka messages
  finish, then pools/clients close and logs flush; a hard deadline (`SHUTDOWN_TIMEOUT_MS`) exits 1
  if anything hangs.

## Tests

```bash
bunx vitest run --project monolith         # unit (src/**/*.spec.ts)
bunx vitest run --project monolith:e2e     # e2e (test/app.e2e-spec.ts) — no Docker needed
```

The e2e suite boots the real `AppModule` with the production HTTP wiring (`configureHttpApp`,
`setupApiDocs`, raw body, multipart) and replaces only the providers that would open a connection:
`REDIS_CLIENT` → `InMemoryRedis`, `DRIZZLE` → real drizzle over a fake postgres.js client, the
identity repositories → in-memory (the real handlers, argon2 and JWTs run), `CASSANDRA_CLIENT`,
the BullMQ `mail` queue (+ no worker), `CACHE_MANAGER` (L1 only), `KafkaProducer` →
`FakeKafkaProducer`, `GRAPHQL_PUB_SUB` → in-process PubSub, `StorageService` → in-memory. See
`test/support/`.

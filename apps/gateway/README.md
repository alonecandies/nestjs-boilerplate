# @app/gateway

The **API gateway** of the microservices topology. It serves the same edge API as the
[monolith](../monolith/README.md) — the same controllers, resolvers, Socket.IO gateway and push
consumer — but every port is bound to a **gRPC adapter** (`XApiModule.forRemote()`) that calls
identity-, notifications- or billing-service with a deadline, retry-on-`UNAVAILABLE`, a circuit
breaker per upstream and the request/correlation ids in the metadata. It owns no data.

```
client ─► HTTP :3000 (Fastify) REST /v1 · GraphQL /graphql · Socket.IO /notifications · /docs
             │  JWT verified HERE (signature + Redis denylist), RBAC, throttling, validation
             ├── gRPC ─► identity-service      :50051  (AuthService, UsersService)
             ├── gRPC ─► notifications-service :50052  (NotificationsService)
             └── gRPC ─► billing-service       :50053  (BillingService)
Kafka notifications.notification-created.v1 (group `gateway-push`)
             └─► Socket.IO room user:{id} (Redis adapter) + GraphQL subscription (Redis PubSub)
```

Access tokens are verified locally (identity-service signs them with the shared
`JWT_ACCESS_SECRET`): no RPC per request for authentication. Upstream errors keep their meaning
across the hop (`EMAIL_TAKEN` stays a 409, validation issues stay `errors[]`), and an upstream
outage becomes a 503 problem+json within `GRPC_DEADLINE_MS` without leaking internals.

## Run it

```bash
bun run setup               # install + copy every .env.example to .env (never overwrites)
bun run docker:infra        # local infrastructure from the root docker-compose.yml
bun run dev:microservices   # gateway + identity + notifications + billing, all in watch mode
bun run dev:gateway         # only the gateway (node --watch on the TS sources, no build step)
```

Production build and start (what the Docker image runs):

```bash
bun run --filter @app/gateway build   # swc → apps/gateway/dist (libs are built by `bun run build`)
cd apps/gateway && bun run start      # node --import ./dist/instrument.js dist/main.js
```

`dist/instrument.js` is preloaded so OpenTelemetry hooks the modules before they are imported (a
no-op unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set). `CLUSTER_WORKERS=N` (0 = one per core) runs N
workers under a supervising primary; keep 1 under Kubernetes and scale pods instead.

## Environment

App-specific overrides live in [`.env.example`](./.env.example); everything else has working
defaults for the local docker-compose infra in `libs/config` (see the root README).

| Variable                                                          | Default                        | Purpose                                                         |
| ----------------------------------------------------------------- | ------------------------------ | --------------------------------------------------------------- |
| `SERVICE_NAME`                                                    | `app`                          | logs, metrics, Kafka client id, Redis connection names → set it |
| `PORT` / `HOST`                                                   | `3000` / 0.0.0.0               | HTTP listener                                                   |
| `KAFKA_GROUP_ID`                                                  | `gateway-push`                 | push-consumer group, shared by every gateway replica            |
| `IDENTITY_GRPC_URL`, `NOTIFICATIONS_GRPC_URL`, `BILLING_GRPC_URL` | `localhost:50051/2/3`          | upstream services                                               |
| `GRPC_DEADLINE_MS`                                                | `5000`                         | per-call deadline (also the service-config timeout)             |
| `JWT_ACCESS_SECRET`                                               | dev default (rejected in prod) | must equal identity-service's                                   |
| `REDIS_URL`                                                       | `redis://localhost:6379`       | denylist, throttling, cache L2, Socket.IO adapter, PubSub       |
| `CLUSTER_WORKERS`, `DOCS_ENABLED`, `MAINTENANCE_MODE`             | `1`, not in prod, `false`      | see the monolith README                                         |

The topic `notifications.notification-created.v1` (and its `.dlq`) must exist — auto-creation is
off.

## Endpoints

| Surface  | Where                                                                                                                                                                                                                                                                                             |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ops      | `GET /health/live`, `GET /health/ready` (redis only), `GET /metrics`, `GET /docs` (Scalar), `GET /openapi.json`, `GET /openapi.yaml`                                                                                                                                                              |
| Identity | `POST /v1/auth/register`, `POST /v1/auth/login`, `POST /v1/auth/refresh`, `POST /v1/auth/logout`, `GET /v1/auth/me`, `GET /v1/users`, `GET /v1/users/:id`, `PATCH /v1/users/:id/roles`                                                                                                            |
| Notifs   | `GET /v1/notifications`, `POST /v1/notifications/:id/read`; Socket.IO namespace `/notifications` (`auth: { token }`, websocket transport)                                                                                                                                                         |
| Billing  | `POST /v1/billing/checkout-sessions`, `POST /v1/billing/webhooks/stripe` (raw bytes + signature forwarded to billing-service), `GET /v1/billing/payments`                                                                                                                                         |
| Files    | `POST /v1/files` (streaming multipart), `POST /v1/files/presigned-uploads`, `GET /v1/files/download-url`, `DELETE /v1/files` — edge-only, straight to object storage                                                                                                                              |
| GraphQL  | `POST /graphql`: `me`, `user`, `users`, `notifications`, `payments` (`Payment.user` batched by the `users` DataLoader); mutations `register`, `login`, `refreshTokens`, `updateUserRoles`, `markNotificationRead`, `createCheckoutSession`, `createUploadUrl`; subscription `notificationCreated` |

Errors are RFC 9457 `application/problem+json`; every response carries `x-request-id` and
`x-correlation-id`, which also travel to the services as gRPC metadata.

## How it is wired

- `src/app.module.ts` — config → observability (readiness: **Redis only**, so an upstream outage
  degrades the affected routes instead of pulling every gateway replica out of the load balancer)
  → Redis + cache → `AuthModule` **before** `AppThrottlerModule` → GraphQL + Redis PubSub →
  storage → the `Api` modules `.forRemote()` + `FilesModule`. No DatabaseModule, Cassandra,
  mailer, Stripe, CQRS or Core module. Root providers: `provideCommonEnhancersAsync`; root
  middleware: `CorrelationIdMiddleware`, `MaintenanceModeMiddleware`.
- `src/main.ts` — `runClustered` → `createHttpApp(AppModule, { rawBody, multipart })` → Redis
  Socket.IO adapter → `connectKafkaConsumer` (group `gateway-push`) → `setupApiDocs` →
  `startAllMicroservices` → `listen`.
- **Startup is fail-fast** on Redis and Kafka (the only hard dependencies): verified against no
  infrastructure (Redis unreachable → exit 1 after `REDIS_CONNECT_TIMEOUT_MS`, ~14 s) and with
  Redis but no Kafka (exit 1 after kafkajs' connection retries, ~9 s). The gRPC upstreams are NOT
  needed to boot: channels connect lazily and each call fails fast (503) while its service is down.
- **Shutdown** (SIGTERM/SIGINT): Fastify stops accepting, in-flight requests and Kafka messages
  finish, gRPC channels/Redis close, logs flush; `SHUTDOWN_TIMEOUT_MS` is the hard deadline.

## Tests

```bash
bunx vitest run --project gateway          # unit (src/**/*.spec.ts)
bunx vitest run --project gateway:e2e      # e2e (test/app.e2e-spec.ts) — no Docker needed
```

The e2e suite boots the real `AppModule` with the production HTTP wiring and binds `AuthPort`,
`UsersPort` and `NotificationsPort` to in-memory fake services (`test/support/fake-upstreams.ts`)
that return the same `@app/contracts` shapes and DomainExceptions as the gRPC adapters. Billing
keeps its real gRPC adapter, pointed at a dead upstream, to assert the 503 mapping. `REDIS_CLIENT`
→ `InMemoryRedis`, `CACHE_MANAGER` → L1 only, `GRAPHQL_PUB_SUB` → in-process PubSub,
`StorageService` → in-memory.

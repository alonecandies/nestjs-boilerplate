# Configuration

Every runtime setting is an environment variable, validated at boot by `@app/config`
([libs/config/src](../libs/config/src)). The apps also boot with **no `.env` at all**: every default
targets the local `docker compose` infra (see [DOCKER.md](DOCKER.md)).

## How configuration is loaded

```mermaid
flowchart LR
  shell["Real environment<br/>(shell, orchestrator, secret store)"] --> penv
  appenv["apps/&lt;app&gt;/.env"] --> penv
  rootenv[".env (repo root)"] --> penv
  penv["process.env"] --> ns["@app/config namespace<br/>(zod schema → typed camelCase object)"]
  ns --> di["@Inject(xConfig.KEY)"]
```

- **Node loads the files, not Nest.** Every app's `dev` and `start` script runs
  `node --env-file-if-exists=../../.env --env-file-if-exists=.env …`, and `AppConfigModule.forRoot()`
  sets `ignoreEnvFile: true`. The single source of truth is `process.env`.
- **Precedence:** real environment variables > `apps/<app>/.env` > root `.env` > schema default
  (Node never overrides a variable already set, and the later `--env-file` wins over the earlier).
- **Namespaces.** Variables are grouped into 14 shared namespaces
  (`libs/config/src/namespaces/*.config.ts`, registered in `CONFIG_NAMESPACES` in
  [all-config.ts](../libs/config/src/all-config.ts)) plus two app-local ones
  (`apps/gateway/src/gateway.config.ts`, `apps/monolith/src/monolith.config.ts`). Each is a zod
  schema keyed by the env var names, transformed into a typed camelCase object.
- **Lazy, per-process validation.** Only `app` and `observability` are loaded globally. Every other
  namespace is loaded with `ConfigModule.forFeature(xConfig)` by the module that injects it, so a
  process only validates (and only fails fast on) the variables it actually uses. Code that runs
  outside Nest DI calls `xConfig.parse()` directly: the cluster primary (`run-clustered.ts`), the
  migration CLI (`libs/database/src/migrate.ts`), each `main.ts` (`SHUTDOWN_TIMEOUT_MS`,
  `KAFKA_GROUP_ID`), and `connectKafkaConsumer` / `connectGrpcServer` when the namespace is not
  already in the container.
- **Fail fast, never leak.** An invalid value throws `EnvValidationError` at boot, naming **every**
  offending variable of the namespace (`Invalid environment for "auth": … → at JWT_ACCESS_SECRET`)
  and never echoing values. `validateAllEnv()` (exported by `@app/config`) checks all 14 shared
  namespaces at once, for scripts and CI.
- **Only `@app/config` reads `process.env`.** Documented exceptions: the OpenTelemetry preload
  (`libs/observability/src/otel.ts`, standard `OTEL_*` variables) and
  `libs/database/drizzle.config.ts` (`DATABASE_URL` for drizzle-kit).

### Value syntax

Shared by every field builder in [env.helpers.ts](../libs/config/src/env/env.helpers.ts):

| Kind    | Accepted                                                                     | Notes                                                       |
| ------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------- |
| any     | blank or whitespace-only = **unset**                                         | `FOO=` falls back to the default instead of `''` / `0`      |
| boolean | `true` `false` `1` `0` (case-insensitive)                                    | `yes`/`on` are rejected                                     |
| integer | strict base 10 (`42`, `-3`)                                                  | rejects `1.5`, `1e3`, `0x10`, `12abc`; bounds are enforced  |
| CSV     | `a, b,,a`                                                                    | trimmed, empties dropped, de-duplicated                     |
| string  | trimmed, non-empty                                                           | some fields add a minimum length or a pattern               |
| URL     | absolute URL                                                                 | some fields restrict the scheme (`postgres`, `redis(s)`, …) |
| enum    | one of the listed values (case-sensitive)                                    |                                                             |
| `.env`  | one `KEY=value` per line, no inline comments, quote values containing spaces | Node `--env-file` syntax                                    |

## .env files layout

| File                              | Committed | Holds                                                                                                                                                        |
| --------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`.env.example`](../.env.example) | yes       | Every `@app/config` variable, grouped by namespace (defaults; tuning knobs commented out), Node runtime variables, then the compose-only section             |
| `apps/<app>/.env.example`         | yes       | Per-app overrides only: `SERVICE_NAME`, `PORT`, `GRPC_URL`, `KAFKA_GROUP_ID`, migration toggles; the gateway also lists its gRPC client targets and deadline |
| `.env`, `apps/<app>/.env`         | no        | Your local copies, read by the host apps (`bun run dev*`, `bun run start`) and, for the root file, by `bun run db:migrate`                                   |
| `.env.docker`                     | no        | Optional extra app environment for the **containers only** (`env_file` with `required: false` in `docker-compose.yml`)                                       |

```bash
bun run setup:env   # copies every .env.example (root + apps/*) to .env when missing — never overwrites
```

`bun run setup` (install + `setup:env`) and every `bun run dev:*` script run it for you. Because the
copy never overwrites, re-run it by deleting the `.env` you want refreshed.

Per-app values that the example files set:

| App                     | `SERVICE_NAME`          | `PORT` | `GRPC_URL` (server bind) | `KAFKA_GROUP_ID`        | Migrations at boot                                              |
| ----------------------- | ----------------------- | ------ | ------------------------ | ----------------------- | --------------------------------------------------------------- |
| `monolith`              | `monolith`              | 3000   | —                        | `monolith`              | `DATABASE_RUN_MIGRATIONS=true`, `CASSANDRA_RUN_MIGRATIONS=true` |
| `gateway`               | `gateway`               | 3000   | — (client only)          | `gateway-push`          | —                                                               |
| `identity-service`      | `identity-service`      | 3001   | `0.0.0.0:50051`          | `identity-service`      | `DATABASE_RUN_MIGRATIONS=true`                                  |
| `notifications-service` | `notifications-service` | 3002   | `0.0.0.0:50052`          | `notifications-service` | `CASSANDRA_RUN_MIGRATIONS=true`                                 |
| `billing-service`       | `billing-service`       | 3003   | `0.0.0.0:50053`          | `billing-service`       | `DATABASE_RUN_MIGRATIONS=true`                                  |

The monolith and the gateway both listen on 3000: run one topology at a time. In containers every
app listens on 3000 and every gRPC server on `0.0.0.0:50051` (see
[Docker Compose-only knobs](#docker-compose-only-knobs)).

## Which app loads which namespace

Derived from each `apps/*/src/app.module.ts` and the `ConfigModule.forFeature()` calls of the libs
it imports. A process ignores (and does not validate) variables of namespaces it does not load.

| Namespace       | monolith |      gateway      | identity-service |  notifications-service  | billing-service | Loaded by                                                          |
| --------------- | :------: | :---------------: | :--------------: | :---------------------: | :-------------: | ------------------------------------------------------------------ |
| `app`           |    ✓     |         ✓         |        ✓         |            ✓            |        ✓        | `AppConfigModule.forRoot()` (global)                               |
| `observability` |    ✓     |         ✓         |        ✓         |            ✓            |        ✓        | `AppConfigModule.forRoot()` (global)                               |
| `database`      |    ✓     |                   |        ✓         |                         |        ✓        | `DatabaseModule`                                                   |
| `cassandra`     |    ✓     |                   |                  |            ✓            |                 | `CassandraModule`                                                  |
| `redis`         |    ✓     |         ✓         |        ✓         |            ✓            |        ✓        | `RedisModule`, `AppQueueModule`, `AppCacheModule`, GraphQL pub/sub |
| `kafka`         |    ✓     | ✓ (consumer only) |   ✓ (producer)   | ✓ (producer + consumer) |  ✓ (producer)   | `KafkaProducerModule`, `connectKafkaConsumer`                      |
| `grpc`          |          |    ✓ (clients)    |    ✓ (server)    |       ✓ (server)        |   ✓ (server)    | `GrpcClientsModule.register()`, app module + `connectGrpcServer`   |
| `auth`          |    ✓     |         ✓         |        ✓         |                         |                 | `AuthModule`                                                       |
| `throttle`      |    ✓     |         ✓         |                  |                         |                 | `AppThrottlerModule`                                               |
| `cache`         |    ✓     |         ✓         |                  |                         |                 | `AppCacheModule`                                                   |
| `graphql`       |    ✓     |         ✓         |                  |                         |                 | `AppGraphqlModule`                                                 |
| `mail`          |    ✓     |                   |                  |            ✓            |                 | `AppMailerModule`                                                  |
| `storage`       |    ✓     |         ✓         |                  |                         |                 | `StorageModule`, `FilesModule`                                     |
| `stripe`        |    ✓     |                   |                  |                         |        ✓        | `StripeModule`, `BillingCoreModule`                                |
| `monolith`      |    ✓     |                   |                  |                         |                 | `apps/monolith/src/main.ts`                                        |
| `gateway`       |          |         ✓         |                  |                         |                 | `apps/gateway/src/main.ts`                                         |

The gateway holds no Postgres, Cassandra, SMTP or Stripe settings: it reaches those contexts over
gRPC (`IdentityApiModule.forRemote()` etc.). The Stripe webhook is received by the gateway and
forwarded as raw bytes + signature to billing-service, which verifies it with
`STRIPE_WEBHOOK_SECRET`.

## Environment variables by namespace

121 distinct variables across the 14 shared namespaces (`node scripts/check-env-example.mjs` prints
the count). "—" = no default (unset). `NODE_ENV` and `SERVICE_NAME` are read by several namespaces
with the same rules; they are listed once, under `app`.

### `app` — HTTP server, CORS, cluster, shutdown, maintenance, docs

[`app.config.ts`](../libs/config/src/namespaces/app.config.ts) · every app

| Variable                     | Default                                       | Description                                                                                                                                                                                                                                           |
| ---------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                   | `development`                                 | `development` \| `test` \| `production`. Production turns on the [guards](#production-guards) and flips the dev-tooling defaults off (docs, GraphQL sandbox/introspection, gRPC reflection). Also read by `observability`, `grpc`, `auth`, `graphql`. |
| `SERVICE_NAME`               | `app`                                         | `[a-z0-9._-]`, max 63 chars. Logs, metrics, OTel `service.name` fallback, Kafka client/group id default, Postgres `application_name`. Also read by `observability`, `kafka`.                                                                          |
| `HOST`                       | `0.0.0.0`                                     | HTTP bind address.                                                                                                                                                                                                                                    |
| `PORT`                       | `3000`                                        | HTTP port (`0`–`65535`; `0` = OS-assigned).                                                                                                                                                                                                           |
| `CORS_ORIGINS`               | `http://localhost:3000,http://localhost:5173` | CSV allowlist for the HTTP API (credentials enabled). Not validated beyond CSV parsing.                                                                                                                                                               |
| `TRUST_PROXY`                | `false`                                       | Whose `X-Forwarded-*` Fastify trusts: `false` (nobody; `req.ip` = socket address), a CSV of IPs/CIDRs/presets (`loopback`, `linklocal`, `uniquelocal`), or `true` (every hop — rejected in production). Hop counts are invalid.                       |
| `BODY_LIMIT_BYTES`           | `1048576`                                     | Max request body (≥ 1).                                                                                                                                                                                                                               |
| `HTTP_KEEP_ALIVE_TIMEOUT_MS` | `72000`                                       | Must exceed the load balancer idle timeout (60 s typical), or the LB reuses closed sockets (502s).                                                                                                                                                    |
| `HTTP_REQUEST_TIMEOUT_MS`    | `30000`                                       | Per-request timeout; also bounds streamed uploads.                                                                                                                                                                                                    |
| `CLUSTER_WORKERS`            | `1`                                           | `node:cluster` workers, `0`–`1024`: `1` = no cluster, `0` = one per core (`os.availableParallelism()`). Containers keep `1` and scale replicas.                                                                                                       |
| `SHUTDOWN_TIMEOUT_MS`        | `10000`                                       | Hard deadline of the graceful shutdown; keep it below the orchestrator grace period.                                                                                                                                                                  |
| `MAINTENANCE_MODE`           | `false`                                       | `503` problem+json with `Retry-After` on every route except `/health*` and `/metrics`.                                                                                                                                                                |
| `DOCS_ENABLED`               | on unless `NODE_ENV=production`               | Swagger/Scalar (`/docs`, `/openapi.json`, `/openapi.yaml`).                                                                                                                                                                                           |

### `observability` — logs, metrics, tracing, `@nestjs/observe`

[`observability.config.ts`](../libs/config/src/namespaces/observability.config.ts) · every app ·
details in [OBSERVABILITY.md](OBSERVABILITY.md)

| Variable                             | Default                        | Description                                                                                               |
| ------------------------------------ | ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `LOG_LEVEL`                          | `info`                         | `fatal` \| `error` \| `warn` \| `info` \| `debug` \| `trace` \| `silent` (pino).                          |
| `LOG_PRETTY`                         | on when `NODE_ENV=development` | pino-pretty output (~5x slower).                                                                          |
| `METRICS_ENABLED`                    | `true`                         | `GET /metrics` (prom-client).                                                                             |
| `METRICS_BEARER_TOKEN`               | —                              | Min 16 chars. When set, `/metrics` answers `404` unless the scrape sends `Authorization: Bearer <token>`. |
| `OTEL_SDK_DISABLED`                  | —                              | Explicit value wins; when unset, tracing is on only if an OTLP endpoint is set.                           |
| `OTEL_EXPORTER_OTLP_ENDPOINT`        | —                              | OTLP base URL (local Jaeger: `http://localhost:4318`, OTLP/HTTP).                                         |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | —                              | Traces-specific endpoint; takes precedence over the base endpoint.                                        |
| `OBSERVE_APP_KEY`                    | —                              | `@nestjs/observe` is wired only when **both** key and secret are set.                                     |
| `OBSERVE_APP_SECRET`                 | —                              | See above.                                                                                                |
| `OBSERVE_SERVICE_ID`                 | `SERVICE_NAME`                 | Service id reported to `@nestjs/observe`.                                                                 |

### `database` — PostgreSQL 18 (postgres.js + Drizzle)

[`database.config.ts`](../libs/config/src/namespaces/database.config.ts) · monolith,
identity-service, billing-service, `bun run db:migrate`

| Variable                        | Default                                 | Description                                                                                              |
| ------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                  | `postgres://app:app@localhost:5432/app` | `postgres://` or `postgresql://` URL.                                                                    |
| `DATABASE_POOL_MAX`             | `20`                                    | Pool size per process, `1`–`1000`.                                                                       |
| `DATABASE_IDLE_TIMEOUT_SEC`     | `30`                                    | **Seconds** (postgres.js); `0` = disabled.                                                               |
| `DATABASE_MAX_LIFETIME_SEC`     | `1800`                                  | Seconds; `0` = disabled.                                                                                 |
| `DATABASE_CONNECT_TIMEOUT_SEC`  | `10`                                    | Seconds (≥ 1).                                                                                           |
| `DATABASE_STATEMENT_TIMEOUT_MS` | `15000`                                 | **Milliseconds** (Postgres `statement_timeout` GUC); `0` = disabled.                                     |
| `DATABASE_PREPARE`              | `true`                                  | Server-side prepared statements; set `false` behind PgBouncer (transaction mode) / RDS Proxy.            |
| `DATABASE_LOG_QUERIES`          | `false`                                 | Log every SQL statement.                                                                                 |
| `DATABASE_RUN_MIGRATIONS`       | `false`                                 | Apply the Drizzle migrations at boot under a Postgres advisory lock; otherwise run `bun run db:migrate`. |

### `cassandra` — notifications inbox

[`cassandra.config.ts`](../libs/config/src/namespaces/cassandra.config.ts) · monolith,
notifications-service

| Variable                       | Default       | Description                                                                             |
| ------------------------------ | ------------- | --------------------------------------------------------------------------------------- |
| `CASSANDRA_CONTACT_POINTS`     | `localhost`   | CSV, at least one host.                                                                 |
| `CASSANDRA_PORT`               | `9042`        |                                                                                         |
| `CASSANDRA_LOCAL_DC`           | `datacenter1` | Must equal the node's data center (`nodetool status`) or the driver ignores every node. |
| `CASSANDRA_KEYSPACE`           | `app`         | CQL identifier `[a-zA-Z][a-zA-Z0-9_]*`, max 48 chars (it is interpolated into CQL).     |
| `CASSANDRA_USERNAME`           | —             | Set together with the password, or neither.                                             |
| `CASSANDRA_PASSWORD`           | —             | See above.                                                                              |
| `CASSANDRA_REPLICATION_FACTOR` | `1`           | Replication of the keyspace created at boot (SimpleStrategy).                           |
| `CASSANDRA_CONSISTENCY`        | `localOne`    | `localOne` \| `localQuorum` \| `quorum` \| `one`.                                       |
| `CASSANDRA_CORE_CONNECTIONS`   | `2`           | Core connections per host.                                                              |
| `CASSANDRA_REQUEST_TIMEOUT_MS` | `12000`       | Driver request timeout.                                                                 |
| `CASSANDRA_RUN_MIGRATIONS`     | `true`        | Create the keyspace and apply the versioned CQL migrations at boot (LWT-locked).        |

### `redis` — cache, locks, throttling, BullMQ, socket.io adapter, GraphQL pub/sub

[`redis.config.ts`](../libs/config/src/namespaces/redis.config.ts) · every app

| Variable                        | Default                  | Description                                                                                                                                             |
| ------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REDIS_URL`                     | `redis://localhost:6379` | `redis://[:password@]host:port[/db]`, or `rediss://` for TLS.                                                                                           |
| `REDIS_KEY_PREFIX`              | `app`                    | `[A-Za-z0-9._-]`, max 64 chars. Applied by the key builder (not ioredis `keyPrefix`, which breaks BullMQ/redlock); also prefixes the socket.io channel. |
| `REDIS_MAX_RETRIES_PER_REQUEST` | `3`                      | ioredis retries per command.                                                                                                                            |
| `REDIS_CONNECT_TIMEOUT_MS`      | `10000`                  |                                                                                                                                                         |

### `kafka` — integration events (kafkajs)

[`kafka.config.ts`](../libs/config/src/namespaces/kafka.config.ts) · every app (the gateway only
consumes)

| Variable                      | Default          | Description                                                                                           |
| ----------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------- |
| `KAFKA_BROKERS`               | `localhost:9094` | CSV, at least one. Host apps use the EXTERNAL listener `localhost:9094`; containers use `kafka:9092`. |
| `KAFKA_CLIENT_ID`             | `SERVICE_NAME`   |                                                                                                       |
| `KAFKA_GROUP_ID`              | `SERVICE_NAME`   | Consumer group. See the note below: the apps pin their own group.                                     |
| `KAFKA_CONSUMER_CONCURRENCY`  | `3`              | Partitions consumed in parallel per instance, `1`–`1000`.                                             |
| `KAFKA_SSL`                   | `false`          | TLS to the brokers.                                                                                   |
| `KAFKA_SASL_MECHANISM`        | —                | `plain` \| `scram-sha-256` \| `scram-sha-512`. When set, username and password are required.          |
| `KAFKA_SASL_USERNAME`         | —                |                                                                                                       |
| `KAFKA_SASL_PASSWORD`         | —                |                                                                                                       |
| `KAFKA_CONNECTION_TIMEOUT_MS` | `3000`           |                                                                                                       |
| `KAFKA_REQUEST_TIMEOUT_MS`    | `30000`          |                                                                                                       |

> **`KAFKA_GROUP_ID` per app.** The shared default (`SERVICE_NAME`) is never what a consumer
> actually joins with: the gateway and the monolith read it through their app-local namespace
> ([below](#app-local-variables)) with fixed defaults `gateway-push` / `monolith`;
> notifications-service ignores it for its consumer and pins `notifications-service`
> (`NOTIFICATIONS_CONSUMER_GROUP` in `apps/notifications-service/src/notifications-service.constants.ts`);
> identity-service and billing-service only produce today. Every replica of an app must share its
> group, and the gateway's group must differ from notifications-service's.

### `grpc` — internal RPC (server bind, client targets, TLS)

[`grpc.config.ts`](../libs/config/src/namespaces/grpc.config.ts) · gateway (clients),
identity/notifications/billing services (servers)

| Variable                       | Default                         | Description                                                                                                                                        |
| ------------------------------ | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GRPC_URL`                     | `0.0.0.0:50051`                 | Server bind address of **this** service (host dev: identity 50051, notifications 50052, billing 50053).                                            |
| `IDENTITY_GRPC_URL`            | `localhost:50051`               | Client target (any grpc-js target syntax: `host:port`, `dns:///svc:port`, …).                                                                      |
| `NOTIFICATIONS_GRPC_URL`       | `localhost:50052`               | Client target.                                                                                                                                     |
| `BILLING_GRPC_URL`             | `localhost:50053`               | Client target.                                                                                                                                     |
| `GRPC_DEADLINE_MS`             | `5000`                          | Default per-call deadline; every client call has one.                                                                                              |
| `GRPC_MAX_MESSAGE_BYTES`       | `4194304`                       | Max send/receive message size (≥ 1024).                                                                                                            |
| `GRPC_TLS_CA_PATH`             | —                               | PEM bundle that signed the **peers'** certificates (client-cert verification on servers; server verification on clients, system roots when unset). |
| `GRPC_TLS_CERT_PATH`           | —                               | PEM certificate. With the key it enables TLS for the server **and** is presented as this process's client certificate (mTLS).                      |
| `GRPC_TLS_KEY_PATH`            | —                               | PEM private key; set together with the certificate.                                                                                                |
| `GRPC_TLS_REQUIRE_CLIENT_CERT` | `true`                          | Servers require a client certificate signed by the CA (mTLS). `false` = server-side TLS only.                                                      |
| `GRPC_ALLOW_INSECURE`          | `false`                         | Explicit opt-out that lets `NODE_ENV=production` boot with plaintext gRPC (service mesh / NetworkPolicy secures it).                               |
| `GRPC_REFLECTION`              | on unless `NODE_ENV=production` | gRPC server reflection (grpcurl / Postman).                                                                                                        |

### `auth` — JWT + Argon2id

[`auth.config.ts`](../libs/config/src/namespaces/auth.config.ts) · gateway, monolith,
identity-service · details in [SECURITY.md](SECURITY.md)

| Variable                | Default                                       | Description                                                                                                                            |
| ----------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `JWT_ACCESS_SECRET`     | `dev-access-secret-change-me-please-32chars`  | HS256 secret, ≥ 32 chars in every environment. **Dev default rejected in production.** The gateway and identity-service must share it. |
| `JWT_ACCESS_TTL_SEC`    | `900`                                         | Access token lifetime (15 min).                                                                                                        |
| `JWT_REFRESH_SECRET`    | `dev-refresh-secret-change-me-please-32chars` | ≥ 32 chars. **Dev default rejected in production**, and it must differ from the access secret there.                                   |
| `JWT_REFRESH_TTL_SEC`   | `604800`                                      | Refresh token lifetime (7 days).                                                                                                       |
| `JWT_ISSUER`            | `nestjs-boilerplate`                          | `iss` claim.                                                                                                                           |
| `JWT_AUDIENCE`          | `nestjs-boilerplate`                          | `aud` claim.                                                                                                                           |
| `ARGON2_MEMORY_COST`    | `19456`                                       | KiB (OWASP baseline m = 19 MiB). Hashing runs on the libuv pool (see `UV_THREADPOOL_SIZE`).                                            |
| `ARGON2_TIME_COST`      | `2`                                           | Iterations.                                                                                                                            |
| `ARGON2_PARALLELISM`    | `1`                                           | Lanes, `1`–`255`.                                                                                                                      |
| `AUTH_DENYLIST_ENABLED` | `true`                                        | Redis denylist of logged-out access tokens (`jti`).                                                                                    |

Generate secrets with:

```bash
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

### `throttle` — rate limiting (Redis-backed `@nestjs/throttler`)

[`throttle.config.ts`](../libs/config/src/namespaces/throttle.config.ts) · gateway, monolith

| Variable               | Default | Description                                                   |
| ---------------------- | ------- | ------------------------------------------------------------- |
| `THROTTLE_TTL_MS`      | `60000` | Default window (**milliseconds**).                            |
| `THROTTLE_LIMIT`       | `100`   | Requests per window, per user (authenticated) or client IP.   |
| `THROTTLE_AUTH_TTL_MS` | `60000` | Window of the stricter credential endpoints (login/register). |
| `THROTTLE_AUTH_LIMIT`  | `10`    | Requests per auth window (brute-force protection).            |

### `cache` — L1 in-process LRU + L2 Redis

[`cache.config.ts`](../libs/config/src/namespaces/cache.config.ts) · gateway, monolith

| Variable             | Default | Description                                                                     |
| -------------------- | ------- | ------------------------------------------------------------------------------- |
| `CACHE_TTL_MS`       | `30000` | L2 (Redis) default TTL.                                                         |
| `CACHE_L1_TTL_MS`    | `5000`  | L1 TTL; must not exceed `CACHE_TTL_MS` (L1 is not invalidated across replicas). |
| `CACHE_L1_MAX_ITEMS` | `5000`  | L1 capacity.                                                                    |

### `graphql` — Apollo on Fastify

[`graphql.config.ts`](../libs/config/src/namespaces/graphql.config.ts) · gateway, monolith ·
usage in [API.md](API.md)

| Variable                 | Default                         | Description                                                                                          |
| ------------------------ | ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `GRAPHQL_PATH`           | `/graphql`                      | Absolute path (`/[A-Za-z0-9/_-]*`).                                                                  |
| `GRAPHQL_SANDBOX`        | on unless `NODE_ENV=production` | Apollo Sandbox landing page (loads assets from Apollo's CDN).                                        |
| `GRAPHQL_INTROSPECTION`  | on unless `NODE_ENV=production` | Schema introspection.                                                                                |
| `GRAPHQL_MAX_COMPLEXITY` | `250`                           | Maximum query complexity.                                                                            |
| `GRAPHQL_SCHEMA_FILE`    | —                               | Also write the code-first schema to this file (e.g. `generated/schema.gql`); unset = in memory only. |

### `mail` — SMTP (nodemailer) + BullMQ mail queue

[`mail.config.ts`](../libs/config/src/namespaces/mail.config.ts) · monolith, notifications-service

| Variable                 | Default                                     | Description                                                   |
| ------------------------ | ------------------------------------------- | ------------------------------------------------------------- |
| `SMTP_HOST`              | `localhost`                                 | Local Mailpit (UI on <http://localhost:8025>).                |
| `SMTP_PORT`              | `1025`                                      |                                                               |
| `SMTP_SECURE`            | `false`                                     | `true` = implicit TLS (465); `false` = STARTTLS when offered. |
| `SMTP_USER`              | —                                           | Set together with the password, or neither.                   |
| `SMTP_PASSWORD`          | —                                           | See above.                                                    |
| `MAIL_FROM`              | `NestJS Boilerplate <no-reply@example.com>` | Sender (quote it in `.env`: it contains spaces).              |
| `SMTP_POOL`              | `true`                                      | Reuse SMTP connections instead of a handshake per mail.       |
| `SMTP_MAX_CONNECTIONS`   | `5`                                         | Pooled connections.                                           |
| `MAIL_QUEUE_CONCURRENCY` | `5`                                         | BullMQ mail worker concurrency.                               |

### `storage` — uploads to S3-compatible storage or GCS

[`storage.config.ts`](../libs/config/src/namespaces/storage.config.ts) · gateway, monolith

| Variable                         | Default                 | Description                                                                                                                   |
| -------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `STORAGE_DRIVER`                 | `s3`                    | `s3` (RustFS locally) \| `gcs` (fake-gcs-server locally).                                                                     |
| `STORAGE_MAX_UPLOAD_BYTES`       | `26214400`              | 25 MiB.                                                                                                                       |
| `STORAGE_MAX_CONCURRENT_UPLOADS` | `4`                     | Streamed uploads (`POST /v1/files`) in flight per process; more get `503` + `Retry-After`. Each holds up to ~15 MiB off-heap. |
| `STORAGE_SIGNED_URL_TTL_SEC`     | `900`                   | Presigned URL lifetime, max `604800` (7 days, the S3 cap).                                                                    |
| `S3_ENDPOINT`                    | `http://localhost:9000` | S3 API endpoint.                                                                                                              |
| `S3_PUBLIC_ENDPOINT`             | `S3_ENDPOINT`           | Host baked into presigned URLs; must be reachable by the client.                                                              |
| `S3_REGION`                      | `us-east-1`             |                                                                                                                               |
| `S3_FORCE_PATH_STYLE`            | `true`                  | Required by RustFS/MinIO-style endpoints without wildcard DNS.                                                                |
| `S3_ACCESS_KEY_ID`               | `rustfsadmin`           | Local RustFS credentials.                                                                                                     |
| `S3_SECRET_ACCESS_KEY`           | `rustfsadmin`           | Local RustFS credentials.                                                                                                     |
| `S3_BUCKET`                      | `uploads`               |                                                                                                                               |
| `GCS_PROJECT_ID`                 | `local-project`         |                                                                                                                               |
| `GCS_BUCKET`                     | `uploads`               |                                                                                                                               |
| `GCS_API_ENDPOINT`               | `http://localhost:4443` | A non-`googleapis.com` host = emulator mode; real GCS: `https://storage.googleapis.com`.                                      |
| `GCS_KEY_FILE`                   | —                       | Service-account key file; unset = Application Default Credentials.                                                            |

### `stripe` — Checkout + webhooks

[`stripe.config.ts`](../libs/config/src/namespaces/stripe.config.ts) · monolith, billing-service

| Variable                     | Default                                 | Description                                                                                                                                                            |
| ---------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STRIPE_SECRET_KEY`          | `sk_test_placeholder`                   | Must start with `sk_test_`, `sk_live_`, `rk_test_` or `rk_live_`. The placeholder is rejected when `NODE_ENV=production`.                                              |
| `STRIPE_WEBHOOK_SECRET`      | `whsec_placeholder`                     | Must start with `whsec_`. Get one from `stripe listen --forward-to localhost:3000/v1/billing/webhooks/stripe`. The placeholder is rejected when `NODE_ENV=production`. |
| `STRIPE_SUCCESS_URL`         | `http://localhost:3000/billing/success` | Checkout redirect (`http`/`https`).                                                                                                                                    |
| `STRIPE_CANCEL_URL`          | `http://localhost:3000/billing/cancel`  | Checkout redirect (`http`/`https`).                                                                                                                                    |
| `STRIPE_MAX_NETWORK_RETRIES` | `2`                                     | `0`–`10`; Stripe retries idempotently.                                                                                                                                 |
| `STRIPE_TIMEOUT_MS`          | `20000`                                 | Stripe API timeout.                                                                                                                                                    |

## App-local variables

Two apps define their own namespace with the same `defineConfigNamespace` machinery (errors name the
variable). Each re-reads `KAFKA_GROUP_ID` with a **fixed** default, so the consumer group never
depends on how the service happens to be named.

| Namespace  | File                                                            | Variable         | Default        | Pattern                 | Used for                                                                     |
| ---------- | --------------------------------------------------------------- | ---------------- | -------------- | ----------------------- | ---------------------------------------------------------------------------- |
| `gateway`  | [`gateway.config.ts`](../apps/gateway/src/gateway.config.ts)    | `KAFKA_GROUP_ID` | `gateway-push` | `[A-Za-z0-9._-]{1,249}` | Push consumer (notification-created → Socket.IO room + GraphQL subscription) |
| `monolith` | [`monolith.config.ts`](../apps/monolith/src/monolith.config.ts) | `KAFKA_GROUP_ID` | `monolith`     | `[A-Za-z0-9._-]{1,249}` | In-process consumers of the integration events                               |

Both are parsed in `main.ts` (`gatewayConfig.parse()` / `monolithConfig.parse()`) and passed to
`connectKafkaConsumer(app, { groupId })`.

## Runtime variables (Node / OpenTelemetry)

Read by Node or the OpenTelemetry SDK themselves, not by `@app/config` (they are listed in
`.env.example` and allow-listed by `scripts/check-env-example.mjs`).

| Variable                      | Default (unset)                         | Description                                                                                                                                                                                                                                                                                                  |
| ----------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `UV_THREADPOOL_SIZE`          | `4` (Node; the Dockerfile `ARG` also 4) | libuv pool: Argon2id, zlib, fs, `dns.lookup`. **Keep it ≤ the CPUs available to the container.** Measured with the monolith capped at 2 CPUs: 4 threads gave p95 36 ms, 16 threads gave p95 304 ms (up to 7.2 s) with dropped iterations (see [DOCKER.md](DOCKER.md)). Raise it together with the CPU limit. |
| `NODE_OPTIONS`                | —                                       | e.g. `--max-old-space-size=512`. Compose sets a per-service heap cap below each container's memory limit.                                                                                                                                                                                                    |
| `OTEL_SERVICE_NAME`           | —                                       | Trace `service.name`. Precedence: `OTEL_SERVICE_NAME` > `SERVICE_NAME` > the app's built-in name.                                                                                                                                                                                                            |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | SDK default                             | e.g. `http/protobuf` (compose sets it).                                                                                                                                                                                                                                                                      |
| `OTEL_TRACES_SAMPLER`         | SDK default                             | e.g. `parentbased_traceidratio`.                                                                                                                                                                                                                                                                             |
| `OTEL_TRACES_SAMPLER_ARG`     | SDK default                             | Sampling ratio, e.g. `1.0`.                                                                                                                                                                                                                                                                                  |

Tracing starts in the `--import ./src/instrument.ts` (dev) / `--import ./dist/instrument.js` (start)
preload, before Nest loads, with the same rule as the `observability` namespace: an explicit
`OTEL_SDK_DISABLED` wins, otherwise tracing is on only when an OTLP endpoint is set. Other standard
`OTEL_*` variables (for example `OTEL_RESOURCE_ATTRIBUTES`) are honoured by the SDK. See
[OBSERVABILITY.md](OBSERVABILITY.md).

## Production guards

Cross-field rules live in each schema's `superRefine`; a violation stops the process at boot with an
`EnvValidationError` naming the variable. Full threat model: [SECURITY.md](SECURITY.md).

**Only when `NODE_ENV=production`:**

| Rule                                                                                                                                  | Variable(s)                                                                                                             | Source             |
| ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------ |
| JWT secrets must not be the development defaults                                                                                      | `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`                                                                               | `auth.config.ts`   |
| Access and refresh secrets must differ (else a refresh token verifies as an access token)                                             | `JWT_REFRESH_SECRET`                                                                                                    | `auth.config.ts`   |
| Stripe key and webhook secret must not be the development placeholders (a known webhook secret would let anyone forge payment events) | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`                                                                            | `stripe.config.ts` |
| `TRUST_PROXY=true` is rejected: list the load balancer IPs/CIDRs instead                                                              | `TRUST_PROXY`                                                                                                           | `app.config.ts`    |
| Plaintext gRPC is refused unless TLS is configured **or** the explicit opt-out is set                                                 | `GRPC_TLS_CERT_PATH` / `GRPC_TLS_KEY_PATH`, or `GRPC_ALLOW_INSECURE=true`                                               | `grpc.config.ts`   |
| Defaults flip off: API docs, GraphQL sandbox and introspection, gRPC reflection, pretty logs                                          | `DOCS_ENABLED`, `GRAPHQL_SANDBOX`, `GRAPHQL_INTROSPECTION`, `GRPC_REFLECTION`, `LOG_PRETTY` (explicit values still win) | several            |

**In every environment:**

| Rule                                                                                                                             | Variable(s)                                                   |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| JWT secrets ≥ 32 characters                                                                                                      | `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`                     |
| `METRICS_BEARER_TOKEN` ≥ 16 characters when set                                                                                  | `METRICS_BEARER_TOKEN`                                        |
| `TRUST_PROXY` is a boolean or a CSV of valid IPs / CIDRs / presets (hop counts are invalid: Fastify ≥ 5.12 fails closed on them) | `TRUST_PROXY`                                                 |
| TLS certificate and key set together                                                                                             | `GRPC_TLS_CERT_PATH`, `GRPC_TLS_KEY_PATH`                     |
| With TLS on and client certificates required, a CA bundle is mandatory                                                           | `GRPC_TLS_CA_PATH` (or `GRPC_TLS_REQUIRE_CLIENT_CERT=false`)  |
| Username and password set together                                                                                               | `CASSANDRA_USERNAME`/`_PASSWORD`, `SMTP_USER`/`SMTP_PASSWORD` |
| SASL mechanism requires username and password                                                                                    | `KAFKA_SASL_*`                                                |
| L1 cache TTL ≤ L2 cache TTL                                                                                                      | `CACHE_L1_TTL_MS`, `CACHE_TTL_MS`                             |
| Stripe key / webhook secret prefixes (`sk_`/`rk_` + `test`/`live`, `whsec_`)                                                     | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`                  |

**Not guarded — check these yourself before going live:**

- `CORS_ORIGINS` is only CSV-parsed. It is applied by `createHttpApp` (gateway, monolith) with
  credentials enabled; the three services' HTTP listeners (health + metrics only) run with CORS off.
  List your real frontend origins and never `*`. The Socket.IO server is websocket-transport-only and
  does not use `CORS_ORIGINS`.
- Storage credentials default to the local RustFS `rustfsadmin` pair.
- `/metrics` is served on the same `PORT` as the API (a separate metrics listener is a known
  follow-up) and is open unless `METRICS_BEARER_TOKEN` is set: set the token, or block the path at
  the load balancer.

Production checklist (secrets from a secret store as real environment variables, which win over any
`.env`):

```dotenv
NODE_ENV=production
# >= 32 chars each, different; the access secret is shared by gateway + identity-service
JWT_ACCESS_SECRET=<random>
JWT_REFRESH_SECRET=<another random>
# your load balancer's addresses, never true
TRUST_PROXY=10.0.0.0/8
CORS_ORIGINS=https://app.example.com
# mTLS between gateway and services (or GRPC_ALLOW_INSECURE=true behind a mesh doing mTLS)
GRPC_TLS_CA_PATH=/etc/grpc/ca.pem
GRPC_TLS_CERT_PATH=/etc/grpc/tls.crt
GRPC_TLS_KEY_PATH=/etc/grpc/tls.key
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
METRICS_BEARER_TOKEN=<at least 16 chars>
# run `bun run db:migrate` (or the image's dist/migrate.js) as a release job instead
DATABASE_RUN_MIGRATIONS=false
```

## Docker Compose-only knobs

Containers **never** receive the root `.env` as app environment. `docker compose` reads it only to
interpolate `${VAR}` in [docker-compose.yml](../docker-compose.yml); each app service gets an
explicit `environment:` block (anchors `x-env-base`, `x-env-auth`, `x-env-postgres`, …) plus the
optional, gitignored `.env.docker`. That is why compose-only knobs are prefixed `DOCKER_` or end in
`_HOST_PORT`: a host-dev value in `.env` cannot leak into a container. Details in
[DOCKER.md](DOCKER.md).

What the containers get regardless of your `.env` (local-only conveniences):

| Variable                                         | Container value                           | Why                                                                                        |
| ------------------------------------------------ | ----------------------------------------- | ------------------------------------------------------------------------------------------ |
| `NODE_ENV`                                       | `${DOCKER_NODE_ENV:-production}`          | Exercise the production guards locally                                                     |
| `GRPC_ALLOW_INSECURE`, `GRPC_REFLECTION`         | `true`                                    | grpcurl/Postman on `127.0.0.1:5005x` without TLS (production: `GRPC_TLS_*`, no reflection) |
| `DOCS_ENABLED`                                   | `${DOCKER_DOCS_ENABLED:-true}`            | `/docs` + `/openapi.json` even in production mode (gateway, monolith)                      |
| `TRUST_PROXY`                                    | `${DOCKER_TRUST_PROXY:-uniquelocal}`      | k6 sends `X-Forwarded-For` from the private network (gateway, monolith)                    |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`        | `${DOCKER_JWT_*_SECRET:-compose-local-…}` | Non-default, distinct, ≥ 32 chars — **not secret**                                         |
| `PORT`, `CLUSTER_WORKERS`, `SHUTDOWN_TIMEOUT_MS` | `3000`, `1`, `15000`                      | Every container serves HTTP on 3000; scale with replicas                                   |
| `GRPC_URL`, `*_GRPC_URL`                         | `0.0.0.0:50051`, `<service>:50051`        | Every gRPC server listens on 50051 inside the network                                      |
| `NODE_OPTIONS`                                   | `--max-old-space-size=…` per service      | Heap cap under each container's memory limit                                               |

### App container settings

| Variable                    | Default                                                | Effect                                                                                                              |
| --------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `COMPOSE_PROFILES`          | —                                                      | Profiles to start without `--profile` (`monolith` \| `microservices`, `observability`, `logs`, `tools`, `loadtest`) |
| `COMPOSE_PROJECT_NAME`      | `boilerplate` (the file's `name:`)                     | Standard compose variable; also handed to Alloy so only this project's container logs are shipped                   |
| `APP_TARGET`                | `runtime`                                              | Image build target: `runtime` (distroless) \| `runtime-alpine` (shell) \| `dev`                                     |
| `TAG`                       | `local`                                                | App image tag                                                                                                       |
| `DOCKER_NODE_ENV`           | `production`                                           | → `NODE_ENV`                                                                                                        |
| `DOCKER_LOG_LEVEL`          | `info`                                                 | → `LOG_LEVEL`                                                                                                       |
| `DOCKER_OTEL_SDK_DISABLED`  | `true`                                                 | → `OTEL_SDK_DISABLED`; `false` sends traces to Jaeger (start the `observability` profile)                           |
| `DOCKER_OTEL_SAMPLER_RATIO` | `1.0`                                                  | → `OTEL_TRACES_SAMPLER_ARG`                                                                                         |
| `DOCKER_DOCS_ENABLED`       | `true`                                                 | → `DOCS_ENABLED`                                                                                                    |
| `DOCKER_STORAGE_DRIVER`     | `s3`                                                   | → `STORAGE_DRIVER`                                                                                                  |
| `DOCKER_TRUST_PROXY`        | `uniquelocal`                                          | → `TRUST_PROXY` (gateway, monolith)                                                                                 |
| `DOCKER_JWT_ACCESS_SECRET`  | `compose-local-access-secret-not-for-production-0001`  | → `JWT_ACCESS_SECRET`                                                                                               |
| `DOCKER_JWT_REFRESH_SECRET` | `compose-local-refresh-secret-not-for-production-0002` | → `JWT_REFRESH_SECRET`                                                                                              |
| `DOCKER_S3_CORS_ORIGINS`    | `http://localhost:3000,http://localhost:5173`          | Browser origins allowed by RustFS's S3 listener (presigned uploads from a frontend)                                 |

### Infra credentials and pass-throughs

| Variable                                            | Default                                                                              | Effect                                                                                                                                                                                      |
| --------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | `app`, `app`, `app`                                                                  | Postgres container + the containers' `DATABASE_URL` (change the host `DATABASE_URL` to match)                                                                                               |
| `RUSTFS_ACCESS_KEY`, `RUSTFS_SECRET_KEY`            | `rustfsadmin`                                                                        | RustFS + the containers' `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`                                                                                                                        |
| `CASSANDRA_DC`                                      | `datacenter1`                                                                        | Cassandra node DC + the containers' `CASSANDRA_LOCAL_DC`                                                                                                                                    |
| `CASSANDRA_HEAP`                                    | `512M`                                                                               | Cassandra JVM heap                                                                                                                                                                          |
| `KAFKA_CLUSTER_ID`                                  | `5L6g3nShT-eMCtK--X86sw`                                                             | KRaft cluster id                                                                                                                                                                            |
| `GRAFANA_ADMIN_USER`, `GRAFANA_ADMIN_PASSWORD`      | `admin`, `admin`                                                                     | Grafana login                                                                                                                                                                               |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`        | `sk_test_compose_local_not_for_production`, `whsec_compose_local_not_for_production` | **Passed through** on purpose: a real Stripe test key in the root `.env` reaches the containers. The fallbacks are compose-local because `NODE_ENV=production` rejects the dev placeholders |
| `CASSANDRA_KEYSPACE`                                | `app`                                                                                | Passed through to the containers                                                                                                                                                            |

### Host ports (all bound to `127.0.0.1`)

| Variable                       | Default  | Service                                                |
| ------------------------------ | -------- | ------------------------------------------------------ |
| `API_HOST_PORT`                | 3000     | `api` (monolith or gateway)                            |
| `POSTGRES_HOST_PORT`           | 5432     | Postgres                                               |
| `REDIS_HOST_PORT`              | 6379     | Redis                                                  |
| `CASSANDRA_HOST_PORT`          | 9042     | Cassandra                                              |
| `KAFKA_HOST_PORT`              | 9094     | Kafka EXTERNAL listener                                |
| `MAILPIT_SMTP_HOST_PORT`       | 1025     | Mailpit SMTP                                           |
| `MAILPIT_UI_HOST_PORT`         | 8025     | Mailpit UI                                             |
| `S3_HOST_PORT`                 | 9000     | RustFS S3 API                                          |
| `S3_CONSOLE_HOST_PORT`         | 9001     | RustFS console                                         |
| `GCS_HOST_PORT`                | 4443     | fake-gcs-server                                        |
| `IDENTITY_GRPC_HOST_PORT`      | 50051    | identity-service gRPC                                  |
| `NOTIFICATIONS_GRPC_HOST_PORT` | 50052    | notifications-service gRPC                             |
| `BILLING_GRPC_HOST_PORT`       | 50053    | billing-service gRPC                                   |
| `KAFKA_UI_HOST_PORT`           | 8080     | Kafka UI (`tools`)                                     |
| `JAEGER_UI_HOST_PORT`          | 16686    | Jaeger UI (`observability`)                            |
| `OTLP_GRPC_HOST_PORT`          | 4317     | OTLP gRPC (`observability`)                            |
| `OTLP_HTTP_HOST_PORT`          | 4318     | OTLP HTTP (`observability`)                            |
| `PROMETHEUS_HOST_PORT`         | 9090     | Prometheus (`observability`)                           |
| `GRAFANA_HOST_PORT`            | **3300** | Grafana (`observability`) — not 3000, which is the API |
| `LOKI_HOST_PORT`               | 3100     | Loki (`logs`)                                          |
| `ALLOY_HOST_PORT`              | 12345    | Alloy (`logs`)                                         |
| `K6_DASHBOARD_HOST_PORT`       | 5665     | k6 web dashboard (`loadtest`)                          |

### k6 load test (`bun run loadtest`)

| Variable            | Default                      | Effect                                                                                  |
| ------------------- | ---------------------------- | --------------------------------------------------------------------------------------- |
| `K6_BASE_URL`       | `http://api:3000`            | Target                                                                                  |
| `K6_RATE`           | `5`                          | New-user journeys per second (5 requests each, 2 Argon2id hashes)                       |
| `K6_READ_RATE`      | `0`                          | Extra authenticated read iterations per second                                          |
| `K6_DURATION`       | `1m`                         | Test duration                                                                           |
| `K6_P95_MS`         | `250`                        | p95 threshold                                                                           |
| `K6_MAX_ERROR_RATE` | `0.01`                       | Error-rate threshold                                                                    |
| `K6_UID`, `K6_GID`  | `1000`                       | uid:gid of the k6 container (Linux: `K6_UID=$(id -u) K6_GID=$(id -g) bun run loadtest`) |
| `K6_OUT`            | `experimental-prometheus-rw` | Set it empty (`K6_OUT=`) when the `observability` profile is not running                |

## Keeping .env.example in sync

| Check                                                                                  | What it enforces                                                                                                                                                                                                                                | Where it runs                                       |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `node scripts/check-env-example.mjs`                                                   | Every variable a schema in `libs/config/src/namespaces` reads is listed in the root `.env.example` (as `KEY=` or `# KEY=`), and nothing unknown appears above the `# docker compose ONLY` marker (Node/OTel runtime variables are allow-listed) | CI "Config drift" step (`.github/workflows/ci.yml`) |
| `apps/{identity,notifications,billing}-service/test/env-example.spec.ts`               | The app's `.env.example` parses against the config namespaces and pins its ports / consumer group                                                                                                                                               | `bun run test`                                      |
| `apps/gateway/src/gateway.config.spec.ts`, `apps/monolith/src/monolith.config.spec.ts` | The app-local namespaces (`KAFKA_GROUP_ID` default and pattern)                                                                                                                                                                                 | `bun run test`                                      |
| `libs/config/src/namespaces/namespaces.spec.ts`                                        | Defaults, derived values and cross-field guards of every shared namespace                                                                                                                                                                       | `bun run test`                                      |

Adding a variable:

1. Add the field to the namespace schema (use the `z*` builders from `@app/config`, which keep the
   blank-means-unset convention) and map it in `.transform()`.
2. Add it to the matching section of the root `.env.example` (commented out if it is a tuning knob).
3. If it belongs in containers, add it to the right `x-env-*` anchor in `docker-compose.yml` (through
   a `DOCKER_*` knob if developers should be able to change it).
4. Document it in this file.

The compose-only section of `.env.example` is not checked by the script; `DOCKER_TRUST_PROXY`
(compose default `uniquelocal`) is currently missing from it.

## Related docs

- [README.md](../README.md) — quick start
- [ARCHITECTURE.md](ARCHITECTURE.md) — topologies, modules and transports
- [DEVELOPMENT.md](DEVELOPMENT.md) — local workflow and scripts
- [API.md](API.md) — REST, GraphQL, WebSocket and gRPC surfaces
- [SECURITY.md](SECURITY.md) — JWT, RBAC, throttling, proxies, gRPC TLS, secrets
- [OBSERVABILITY.md](OBSERVABILITY.md) — logs, metrics, tracing
- [PERFORMANCE.md](PERFORMANCE.md) — tuning knobs and measurements
- [DOCKER.md](DOCKER.md) — images, compose profiles, container settings
- [TESTING.md](TESTING.md) — unit, e2e and integration suites
- [RELEASING.md](RELEASING.md) — versioning and changelogs
- [`libs/config/README.md`](../libs/config/README.md) — the `@app/config` package API

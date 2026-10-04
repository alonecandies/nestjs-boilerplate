# identity-service

The identity bounded context as a standalone microservice: users, registration, login (Argon2id),
access/refresh JWTs with refresh-token rotation and reuse detection, logout (access-token
denylist) and role administration. It serves **gRPC only**; the gateway exposes the public REST /
GraphQL API and calls this service through `IdentityApiModule.forRemote()`.

| Surface | Port (default)             | What                                                                        |
| ------- | -------------------------- | --------------------------------------------------------------------------- |
| gRPC    | `GRPC_URL` `0.0.0.0:50051` | `identity.v1.AuthService`, `identity.v1.UsersService`, health, reflection   |
| HTTP    | `PORT` `3001`              | `GET /health/live`, `GET /health/ready`, `GET /metrics` only                |
| Kafka   | produces                   | `identity.user-registered.v1` (key `userId`; envelope id = domain event id) |

The domain logic lives in [`@app/identity`](../../libs/identity/README.md); this app is only the
composition root.

## Composition (`src/app.module.ts`)

| Module                                                                   | Why                                                                                                                |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `AppConfigModule.forRoot()` + `ConfigModule.forFeature(grpcConfig)`      | `app`/`observability` + the gRPC bind namespace `connectGrpcServer` reads, validated at boot                       |
| `ObservabilityModule.forRoot({ healthContributors: [postgres, redis] })` | pino JSON logs, request context, `/metrics`, `/health/*`; Kafka is not a readiness dependency (best-effort events) |
| `CqrsModule.forRoot()`, `ScheduleModule.forRoot()`                       | command/query buses; `PurgeExpiredSessionsCron` (hourly, `@WithLock`)                                              |
| `DatabaseModule.forRootAsync({ schema: identitySchema })`                | Drizzle + postgres.js pool, transactional CLS plugin, boot-time migrations                                         |
| `RedisModule.forRootAsync()`                                             | access-token denylist, distributed cron lock                                                                       |
| `KafkaProducerModule.forRootAsync()`                                     | idempotent producer for `UserRegisteredRelay`                                                                      |
| `AuthModule.forRootAsync({ globalGuards: false })`                       | `TokenService`, `PasswordHasher`, `AccessTokenDenylist`; no guards: only the gateway calls it                      |
| `IdentityGrpcModule`                                                     | `IdentityCoreModule` + `AuthGrpcController`, `UsersGrpcController`                                                 |
| `provideCommonEnhancersAsync(...)`, `CorrelationIdMiddleware`            | problem+json on the ops port; with `inheritAppConfig` the enhancers wrap gRPC too                                  |

`main.ts`: `createServiceApp(AppModule)` → `connectGrpcServer(app, ['identity'])` →
`startAllMicroservices()` → `listen(app)`. The HTTP port opens last, so readiness probes only see
the pod once gRPC accepts calls.

| RPC                            | Dispatches                            |
| ------------------------------ | ------------------------------------- |
| `AuthService.Register`         | `RegisterUserCommand`                 |
| `AuthService.Login`            | `LoginCommand`                        |
| `AuthService.RefreshTokens`    | `RefreshSessionCommand`               |
| `AuthService.Logout`           | `LogoutCommand`                       |
| `UsersService.GetUser`         | `GetUserByIdQuery`                    |
| `UsersService.GetUsersByIds`   | `GetUsersByIdsQuery` (one `IN` query) |
| `UsersService.ListUsers`       | `ListUsersQuery` (keyset pagination)  |
| `UsersService.UpdateUserRoles` | `UpdateUserRolesCommand`              |

Errors cross the wire as gRPC statuses plus an `x-error-code` trailer (`NOT_FOUND`, `EMAIL_TAKEN` →
`ALREADY_EXISTS`, `INVALID_CREDENTIALS` → `UNAUTHENTICATED`, zod payload errors →
`INVALID_ARGUMENT` with issues); unexpected errors are `INTERNAL` with the message hidden.

## Configuration

`.env.example` holds only what differs per service; `bun run setup:env` copies it to `.env`.
Everything else comes from the root `.env` / the environment ([`@app/config`](../../libs/config)):

| Variable                                                    | Value here                 | Notes                                                                              |
| ----------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------- |
| `SERVICE_NAME`                                              | `identity-service`         | log `service`, Kafka client id, envelope `source`, pool `application_name`         |
| `PORT` / `GRPC_URL`                                         | `3001` / `0.0.0.0:50051`   | the gateway dials `IDENTITY_GRPC_URL`                                              |
| `KAFKA_GROUP_ID`                                            | `identity-service`         | no consumer today; explicit so a future one never shares a group                   |
| `DATABASE_RUN_MIGRATIONS`                                   | `true`                     | advisory-locked; set `false` when a `bun run db:migrate` job owns it               |
| `DATABASE_URL`, `REDIS_URL`, `KAFKA_BROKERS`                | root `.env`                |                                                                                    |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`                   | root `.env` / secret store | the dev defaults are rejected when `NODE_ENV=production`                           |
| `ARGON2_*`, `GRPC_MAX_MESSAGE_BYTES`, `SHUTDOWN_TIMEOUT_MS` | defaults                   | Argon2 hashing runs on the libuv pool; raise `UV_THREADPOOL_SIZE` under login load |

## Running

```bash
bun run docker:infra                                  # Postgres, Redis, Kafka (+ topics) from the root compose
bun run dev:identity                                  # node --watch on the TS sources (no build)
bun run --filter @app/identity-service build          # SWC → dist/
bun run --filter @app/identity-service start          # node --import ./dist/instrument.js dist/main.js
```

`src/instrument.ts` is preloaded (`--import`) by `start` (from `dist/`) and by `bun run dev` (from
the TS sources, after the swc-node loader) so OpenTelemetry hooks the loader before Nest,
postgres.js, ioredis, kafkajs and grpc-js load; it is a no-op without an OTLP endpoint.

Scaffold providers/controllers with `bun run g <schematic> <name>` from this folder (e.g.
`bun run g service foo`): it runs `nest g` and then `eslint --fix src`, because the Nest
schematics import `TestingModule` as a value and `consistent-type-imports` would fail
`bun run check`.

## Boot, degradation and shutdown

Measured with the dist entrypoint (`NODE_ENV=production`) against throwaway containers, except the
rows marked _by design_:

| Situation                                                                  | Behaviour                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nothing reachable                                                          | **fails fast**: the boot-time migration lock gets `ECONNREFUSED`, one `fatal` log, exit code 1 after ~3 s                                                                                                                                                                                                                                                             |
| Postgres down (_by design_)                                                | fails fast the same way (migrations, or the pool's `select 1` retry when migrations are off)                                                                                                                                                                                                                                                                          |
| Redis down (_by design_)                                                   | fails fast after `REDIS_CONNECT_TIMEOUT_MS` (10 s, as measured on notifications-service): the denylist fails closed, so running without Redis is unsafe                                                                                                                                                                                                               |
| **Kafka down**, Postgres + Redis up (_by design_, covered by the e2e spec) | **boots degraded and stays ready**: gRPC works (register, login, lookups), `/health/ready` is 200 (Kafka is not a readiness contributor: publishing is best-effort, so a broker outage must not pull every replica out of rotation), the producer logs and reconnects in the background; `identity.user-registered.v1` events of that window are lost (no outbox yet) |
| Everything up                                                              | ready 200; `Register` → Kafka → notifications-service stores the welcome notification within ~1 s                                                                                                                                                                                                                                                                     |
| `SIGTERM`                                                                  | gRPC health `NOT_SERVING` → HTTP + gRPC drain → Postgres pool, Redis, Kafka closed → exit 0 in ~1 s; hard exit 1 after `SHUTDOWN_TIMEOUT_MS`                                                                                                                                                                                                                          |

Boot failures before the logger is attached (DI errors) are printed by Nest's console logger; later
ones (e.g. while starting the transports) are pino JSON with the error as `err`.

## Tests

```bash
bunx vitest run --project identity-service --project identity-service:e2e
```

- `test/app.e2e-spec.ts` boots the **real `AppModule`** with fakes only at the network edges: a real
  drizzle instance over a fake postgres.js client (`DRIZZLE`), `InMemoryRedis` (`REDIS_CLIENT`) and
  `FakeKafkaProducer`. It checks `/health/live`, `/metrics`, `/health/ready` (exactly
  postgres/redis, 200 while `KAFKA_BROKERS` is unreachable), a problem+json 404, and real gRPC
  round trips from a gateway-style `ClientGrpcProxy`: `GetUser` (Timestamp → `Date`), `NOT_FOUND` + `x-error-code`, `INVALID_ARGUMENT`
  before any SQL, `Login` → `UNAUTHENTICATED`/`INVALID_CREDENTIALS`, breaker stays closed.
- `test/env-example.spec.ts` validates `.env.example` against every config namespace and pins the
  ports.

No Docker is needed. `libs/identity` has the unit tests and a Postgres integration test
(`INTEGRATION=1`).

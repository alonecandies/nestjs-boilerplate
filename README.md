# nestjs-boilerplate

NestJS 12 (ESM, Fastify) monorepo boilerplate. One codebase, two topologies:

- **Modular monolith** (`apps/monolith`): every bounded context (identity, notifications, billing, files) in one
  process, REST + GraphQL + Socket.IO, ports wired to the local CommandBus/QueryBus.
- **Microservices**: `apps/gateway` (REST/GraphQL/WS edge, ports wired to gRPC clients) in front of
  `identity-service`, `notifications-service` and `billing-service` (gRPC), with Kafka for integration events.

Stack: PostgreSQL 18 + Drizzle, Cassandra, Redis (cache, locks, throttling, BullMQ), Kafka, gRPC, GraphQL (Apollo),
Socket.IO, CQRS, JWT + RBAC, zod, pino / Prometheus / OpenTelemetry, S3 (RustFS) / GCS, Stripe.

## Prerequisites

| Tool   | Version                                                            |
| ------ | ------------------------------------------------------------------ |
| Node   | 24 LTS (`.nvmrc`); Node is the runtime of every app, tool and test |
| Bun    | 1.4.2, used as the **package manager only**                        |
| Docker | Docker Desktop / Engine with Compose v2.24+ (budget: 4 CPU / 4 GB) |

## Quickstart

```bash
bun run setup                 # bun install + copy every missing .env from its .env.example (never overwrites)
docker compose up -d --wait   # infra only: Postgres, Redis, Cassandra, Kafka, Mailpit, RustFS, fake-gcs
bun run dev                   # monolith on the host -> http://localhost:3000 (docs: /docs)
bun run dev:microservices     # or: gateway + identity/notifications/billing services
```

The per-app settings that must differ between apps (`SERVICE_NAME`, `PORT`, `GRPC_URL`, `DATABASE_RUN_MIGRATIONS`)
live **only** in `apps/*/.env` (from `apps/*/.env.example`). Every root `dev*` script runs `bun run setup:env` first, so
those files exist. If you start an app another way, run `bun run setup:env` once first.

## Commands

| Command                                                                                                      | What                                                         |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| `bun run dev` / `dev:microservices` / `dev:<app>`                                                            | apps on the host (watch mode, TS sources, no build)          |
| `bun run check`                                                                                              | Biome, ESLint, Prettier, `tsc` (the CI quality gate)         |
| `bun run lint` / `lint:fix` / `format`                                                                       | lint and format                                              |
| `bun run test` / `test:e2e` / `test:cov`                                                                     | Vitest unit + e2e (fakes at the network edges)               |
| `bun run test:int`                                                                                           | integration tests (`*.int-spec.ts`), needs Docker            |
| `bun run build`                                                                                              | SWC build of every package (Lerna + Nx, cached, topological) |
| `bun run proto:gen` / `db:generate` / `db:migrate`                                                           | regenerate gRPC types / Drizzle migrations; apply migrations |
| `bun run docker:infra` / `docker:monolith` / `docker:microservices` / `docker:observability` / `docker:down` | compose shortcuts                                            |
| `bun run loadtest`                                                                                           | k6 against whichever topology runs                           |
| `bun run commit` / `release`                                                                                 | Conventional Commits (commitizen) / Lerna versioning         |

## Ports (host, 127.0.0.1)

| Port                   | Service                                                                   |
| ---------------------- | ------------------------------------------------------------------------- |
| 3000                   | monolith or gateway (HTTP API, GraphQL, Socket.IO, `/docs`)               |
| 3001 / 3002 / 3003     | identity / notifications / billing service on the host (health + metrics) |
| 50051 / 50052 / 50053  | identity / notifications / billing gRPC                                   |
| 5432, 6379, 9042, 9094 | Postgres, Redis, Cassandra, Kafka (EXTERNAL listener)                     |
| 1025 / 8025            | Mailpit SMTP / UI                                                         |
| 9000 / 9001, 4443      | RustFS S3 / console, fake-gcs                                             |
| 3300, 9090, 16686      | Grafana, Prometheus, Jaeger (`observability` profile)                     |

Every infra port can be moved with a `*_HOST_PORT` variable (see the compose-only section of `.env.example`).

## Documentation

- [docs/DOCKER.md](docs/DOCKER.md): local infrastructure, compose profiles, dev loops, images, observability, load
  testing, CI.
- Apps: [monolith](apps/monolith/README.md), [gateway](apps/gateway/README.md),
  [identity-service](apps/identity-service/README.md), [notifications-service](apps/notifications-service/README.md),
  [billing-service](apps/billing-service/README.md).
- Domain libs: [identity](libs/identity/README.md), [notifications](libs/notifications/README.md),
  [billing](libs/billing/README.md), [files](libs/files/README.md).
- Infrastructure libs: [auth](libs/auth/README.md), [bootstrap](libs/bootstrap/README.md),
  [cassandra](libs/cassandra/README.md), [common](libs/common/README.md), [config](libs/config/README.md),
  [contracts](libs/contracts/README.md), [database](libs/database/README.md), [graphql](libs/graphql/README.md),
  [mailer](libs/mailer/README.md), [observability](libs/observability/README.md), [payments](libs/payments/README.md),
  [redis](libs/redis/README.md), [storage](libs/storage/README.md), [testing](libs/testing/README.md),
  [transport](libs/transport/README.md).
- Configuration: every environment variable, with its default, is documented in [.env.example](.env.example).

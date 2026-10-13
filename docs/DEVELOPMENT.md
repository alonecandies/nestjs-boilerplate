# Development

This is the day-to-day guide for working on this monorepo. It covers setup, the dev loop, generators, step-by-step recipes and troubleshooting.

Related docs: [README](../README.md), [Architecture](ARCHITECTURE.md), [Configuration](CONFIGURATION.md), [API](API.md), [Testing](TESTING.md), [Docker](DOCKER.md), [Observability](OBSERVABILITY.md), [Performance](PERFORMANCE.md), [Security](SECURITY.md), [Releasing](RELEASING.md).

## Prerequisites

| Tool                          | Version                                                 | Notes                                                                                                                                                |
| ----------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js                       | **24 LTS** (`.nvmrc` = `24`, `engines.node` `>=24 <25`) | The only runtime: apps, tests, scripts and tooling all run on Node.                                                                                  |
| Bun                           | **1.4.3** (`packageManager`)                            | Used **only** as the package manager and script runner. `bunfig.toml` sets `[run] bun = false`, so `bun run` never swaps `node` for Bun.             |
| Docker + Compose              | recent Docker Desktop / Engine                          | Runs the local infra: Postgres 18, Redis, Cassandra, Kafka, Mailpit, RustFS (S3), fake-gcs, plus optional observability. See [DOCKER.md](DOCKER.md). |
| `buf` / `protoc-gen-ts_proto` | installed as dev dependencies                           | Only needed for `bun run proto:gen`. Nothing to install globally.                                                                                    |
| Stripe CLI (optional)         | any                                                     | Forwards webhooks to your machine: `stripe listen --forward-to localhost:3000/v1/billing/webhooks/stripe`.                                           |

Pinned on purpose (do not "upgrade" these without reading why). Everything else is the latest stable version as of 2026-09:

| Pin                                                    | Why                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript **6.0.3**                                   | TS 7 (the Go port) has no JS compiler API. typescript-eslint supports `<6.1`, the Nest CLI bundles `~6.0`, and the swagger/graphql CLI plugins need the compiler API.                                                                                                                                                                                                   |
| `@types/node` **24**                                   | Matches the Node 24 LTS runtime.                                                                                                                                                                                                                                                                                                                                        |
| `protobufjs` **7** (root `overrides`)                  | `@grpc/proto-loader` + ts-proto register the `google.protobuf.Timestamp` ↔ `Date` wrapper on the protobufjs instance they share. A v8 copy silently breaks that mapping.                                                                                                                                                                                                |
| `conventional-changelog-conventionalcommits` **9.3.1** | Lerna 10 crashes with 10.x. See [RELEASING.md](RELEASING.md).                                                                                                                                                                                                                                                                                                           |
| `inquirer` **12**                                      | Peer dependency of `@commitlint/cz-commitlint`.                                                                                                                                                                                                                                                                                                                         |
| `lodash-es`, not `lodash`                              | `lodash` is CommonJS, so ESM named imports (`import { isNil } from 'lodash'`) fail. `lodash-es` is native ESM.                                                                                                                                                                                                                                                          |
| Bun `linker = "hoisted"` (`bunfig.toml`)               | NestJS packages declare each other as cyclic optional peers. The isolated linker created several copies of `@nestjs/core`, which split the "realm": `instanceof` checks broke, DI tokens were duplicated and `ClientsModule` loaded twice. Biome's `correctness/noUndeclaredDependencies` (error) keeps dependency hygiene: every package must declare what it imports. |

## First-time setup

```bash
git clone <repo> && cd nestjs-boilerplate
nvm use                     # Node 24 from .nvmrc
bun run setup               # = bun install && bun run setup:env
bun run docker:infra        # = docker compose up -d --wait (infra only, no app profile)
bun run dev                 # monolith on http://localhost:3000
```

- `bun install` runs the `prepare` script (`husky`), which installs the git hooks. See [RELEASING.md](RELEASING.md#git-hooks-husky).
- `bun run setup:env` (`scripts/setup-env.mjs`) copies the root `.env.example` and every `apps/*/.env.example` to `.env` **when it is missing**. It never overwrites an existing file.
- `bun run docker:infra` starts the infra and waits for the one-shot init jobs: Kafka topics, the Cassandra keyspace and the buckets. Postgres tables are created by the apps at boot because `DATABASE_RUN_MIGRATIONS=true` is set in `apps/*/.env`. You can also run `bun run db:migrate` yourself.
- Check that it works: `curl -s localhost:3000/health/ready`, then open `http://localhost:3000/docs` (Scalar/Swagger), `http://localhost:3000/graphql` (Apollo Sandbox) and Mailpit at `http://localhost:8025`.

## Environment files

| File                      | Holds                                                                                                                                                                                  | Committed?      |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `.env.example` (root)     | Every variable of the platform and domain config namespaces, grouped by namespace, with its default. A bottom section holds the docker-compose-only knobs (`DOCKER_*`, `*_HOST_PORT`). | yes             |
| `apps/<app>/.env.example` | Per-app overrides only: `SERVICE_NAME`, `PORT`, `GRPC_URL`, `KAFKA_GROUP_ID`, `DATABASE_RUN_MIGRATIONS`, `CASSANDRA_RUN_MIGRATIONS`, and the gateway's upstream `*_GRPC_URL`.          | yes             |
| `.env`, `apps/<app>/.env` | Your local copies, created by `bun run setup:env`.                                                                                                                                     | no (gitignored) |

**Load order.** Each app's `dev`/`start` script passes `--env-file-if-exists=../../.env --env-file-if-exists=.env`. Real environment variables win, then `apps/<app>/.env`, then the root `.env`. The defaults in `libs/config` apply last, and they already target the local compose infra, so the apps can boot with no `.env` at all.

**Why the per-app files matter.** Without them every app would bind HTTP `3000` and gRPC `0.0.0.0:50051`, and the services would not apply migrations. Every root `dev*` script runs `setup:env` first. If you start an app another way, for example `bun run dev` inside `apps/<app>`, run `bun run setup:env` once.

**Adding a variable.** Add it to its owner's namespace schema: a platform variable to `libs/config/src/namespaces/*.config.ts`, a domain-owned one to the domain's `domains/<x>/src/**/*.config.ts` (each `*-service` app that loads that namespace passes it to `validateAllEnv(env, [...])` in its `test/env-example.spec.ts`). Then document it in the root `.env.example` (as `KEY=` or `# KEY=`), which lists the variables of both. `node scripts/check-env-example.mjs` reads the schema sources (no build needed) and fails when the two drift; `--list` shows which file declares each variable. CI runs it. All variables are listed in [CONFIGURATION.md](CONFIGURATION.md).

Compose reads the root `.env` only for `${VAR}` interpolation. Containers get their environment from `docker-compose.yml`. See [DOCKER.md](DOCKER.md).

## The dev loop

Every app has the same `dev` script (`apps/*/package.json`):

```bash
node --watch --watch-preserve-output \
  --env-file-if-exists=../../.env --env-file-if-exists=.env \
  --enable-source-maps \
  --conditions=@repo/source \
  --import @swc-node/register/esm-register \
  --import ./src/instrument.ts \
  src/main.ts
```

| Piece                                      | What it does                                                                                                                                                                                                                            |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node --watch`                             | Node's built-in watcher restarts the process when any imported file changes, including files under `domains/*/src` and `libs/*/src`. No nodemon and no `nest start --watch`.                                                            |
| `--conditions=@repo/source`                | Every workspace package exports `{ "@repo/source": "./src/index.ts", "types": "./src/index.ts", "default": "./dist/index.js" }`. With this condition Node resolves `@domain/*` and `@platform/*` imports to the **TypeScript sources**. |
| `--import @swc-node/register/esm-register` | An ESM loader hook that transpiles `.ts` on the fly with SWC, including legacy decorators and `emitDecoratorMetadata`, which Nest DI needs.                                                                                             |
| `--import ./src/instrument.ts`             | Starts OpenTelemetry (`@platform/observability/otel`) **before** Nest, postgres.js, ioredis, kafkajs and grpc-js are loaded. It does nothing unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set.                                               |
| `--enable-source-maps`                     | Stack traces point at `.ts` lines.                                                                                                                                                                                                      |

**Why no library build is needed.** The same `@repo/source` condition is honoured in three places:

1. the `exports` map of each package (Node at dev time),
2. `customConditions: ["@repo/source"]` in `tsconfig.base.json` (typecheck and editor),
3. `ssr.resolve.conditions` in `vitest.config.ts`, which also drops `development|production` so tests resolve exactly what Node resolves (a single `graphql` realm).

Typecheck, tests and `dev` therefore all read `domains/*/src` and `libs/*/src` directly. You only need `dist/` (`bun run build`) for production-style runs: each app's `start` script, `bun run --filter @app/<app> db:migrate`, `node scripts/docker/check-kafka-topics.mjs`, and Docker images.

Everyday commands:

| Command                                    | Purpose                                                                                                                                                         |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run typecheck`                        | One `tsc -p tsconfig.json` over every app and lib, from sources.                                                                                                |
| `bun run test` / `bun run test:watch`      | Vitest. Each package under `apps/`, `domains/` and `libs/` is a project named after its folder (`<domain>-contracts` for a contracts package).                  |
| `bunx vitest run --project billing`        | One project (`<app>:e2e` for an app's e2e suite).                                                                                                               |
| `bun run lint` / `bun run lint:fix`        | Biome, then type-aware ESLint.                                                                                                                                  |
| `bun run format`                           | Biome format + Prettier (Markdown/YAML).                                                                                                                        |
| `bun run check`                            | The full static gate CI runs: `biome ci`, `eslint --max-warnings=0`, `prettier --check`, `tsc`, then the layer boundary check (`scripts/check-boundaries.mjs`). |
| `bun run build` / `bun run build:affected` | SWC build of every package (Lerna + Nx, cached and topological) or only those changed since `origin/master`.                                                    |
| `bun run graph`                            | Nx project graph.                                                                                                                                               |

More about tests in [TESTING.md](TESTING.md).

## Running each topology locally

One codebase can run as two topologies. The REST, GraphQL and Socket.IO surface is the same in both. Only the binding of the domain ports changes: `XApiModule.forLocal()` uses the in-process CQRS buses, and `XApiModule.forRemote()` uses gRPC clients to call the services. See [ARCHITECTURE.md](ARCHITECTURE.md).

| Topology      | Command                                                                                                      | Processes (HTTP / gRPC)                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Monolith      | `bun run dev` (= `dev:monolith`)                                                                             | monolith `3000`                                                                                                                |
| Microservices | `bun run dev:microservices` (all four with `concurrently`, prefixed `gateway`/`identity`/`notify`/`billing`) | gateway `3000` · identity-service `3001` / `50051` · notifications-service `3002` / `50052` · billing-service `3003` / `50053` |
| Single app    | `bun run dev:gateway`, `dev:identity`, `dev:notifications`, `dev:billing`                                    | as above                                                                                                                       |

The services only serve `/health/live`, `/health/ready` and `/metrics` over HTTP. Their API is gRPC, and only the gateway calls it. In every app, `/metrics` shares the HTTP port. Set `METRICS_BEARER_TOKEN` to require a bearer token. A separate metrics listener is a known follow-up. Run either the monolith or the gateway, never both, because both bind port 3000.

Infra must be up first (`bun run docker:infra`). Other loops:

- **Everything in Docker**: `bun run docker:monolith` or `bun run docker:microservices`, which build images. `docker compose --profile microservices watch` rebuilds an app on change.
- **Hybrid**: services in Docker and one app on the host. The service containers publish 50051–50053 on the host, so `bun run dev:gateway` reaches them with its default `.env`.
- **Observability**: `bun run docker:observability` adds Jaeger (`16686`), Prometheus (`9090`) and Grafana on host port **`3300`**, because 3000 belongs to the API. For traces from host apps, set `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`. See [OBSERVABILITY.md](OBSERVABILITY.md).
- `bun run docker:down` stops everything, every profile included.

Profiles, ports and resource budgets are covered in [DOCKER.md](DOCKER.md).

Smoke test (either topology):

```bash
curl -s localhost:3000/health/ready
curl -s localhost:3000/graphql -H 'content-type: application/json' -d '{"query":"{ __typename }"}'
```

Endpoints and payloads are listed in [API.md](API.md).

### Running the built apps (`dist`)

After `bun run build`, start an app from its own directory. The `start` script loads `../../.env` and `.env` for you;
with an explicit env file, put `--import ./dist/instrument.js` (the OpenTelemetry preload) **before** `dist/main.js`:

```bash
cd apps/monolith
node --env-file=/path/to/monolith.env --import ./dist/instrument.js dist/main.js
```

Verified behaviour against warm compose infra:

- The monolith is ready in about 1.3 s and logs `Readiness contributors: postgres, cassandra, redis`, then
  `monolith listening on http://…:3000`. Kafka, S3, SMTP and Stripe are not readiness gates. Each microservice boots in
  about 1 s. A `0.0.0.0` bind is printed as `http://127.0.0.1:<port>` (Nest's `getUrl()`), but the server listens on
  every interface.
- **Microservices start order** used: identity-service, notifications-service, billing-service, then the gateway. The
  gateway does not need its upstreams to boot (gRPC channels connect lazily). gRPC servers bind `GRPC_URL`
  (`0.0.0.0:5005x`) and log `Nest microservice successfully started`, without the address.
- `JWT_ACCESS_SECRET` must be identical on identity-service and the gateway (the dev default works when both leave it
  unset). billing-service needs `STRIPE_WEBHOOK_SECRET`: the gateway forwards the raw webhook bytes and signature over
  gRPC.
- **Infra on remapped host ports** (for example when 5432 or 6379 are taken): set `DATABASE_URL`, `REDIS_URL`,
  `CASSANDRA_CONTACT_POINTS` + `CASSANDRA_PORT` + `CASSANDRA_LOCAL_DC=datacenter1`, `KAFKA_BROKERS` (the EXTERNAL
  listener, which must advertise the same `host:port` the app dials), `SMTP_HOST`/`SMTP_PORT`, `S3_ENDPOINT` **and**
  `S3_PUBLIC_ENDPOINT` (presigned URLs are built from the public one), `GCS_API_ENDPOINT`. `LOG_PRETTY=false` gives
  JSON logs in development.
- **SIGTERM** shuts down gracefully in 1-3.5 s: `SIGTERM received; forcing exit in 10000 ms if still running` →
  `Cassandra client closed` / `Postgres pool closed` → `Shutdown complete (SIGTERM)`, with Kafka offsets committed
  (consumer lag 0 afterwards).
- Consumers subscribe with `fromBeginning: false`: a brand-new group starts at the latest offset, while a group with
  committed offsets resumes where it stopped (events published while it was down are processed on restart).
  Redelivery is safe: inbox ids are deterministic (`welcome:<userId>`), so processing an event twice is idempotent.

## Generating code

Each **app** has a `g` script: `sh -c 'nest g "$@" && eslint --fix src' nest-g`. It runs the Nest CLI schematic, then ESLint `--fix` on `src`, which converts imports to the repo's `import type` style. Run it from the app folder:

```bash
cd apps/monolith
bun run g module reports           # src/reports/reports.module.ts
bun run g controller reports       # + reports.controller.spec.ts (generateOptions.spec: true)
bun run g service reports --dry-run
```

`apps/*/nest-cli.json` sets `sourceRoot: src`, `generateOptions: { spec: true, flat: false }` and the SWC builder (`typeCheck: false`; type checking is the root `tsc`).

What to expect:

- The generated code is a starting point. Check the relative imports (they must end in `.js`) and that every class Nest injects is imported as a value. See [DI pitfalls](#conventions-and-di-pitfalls).
- **Domain and platform packages have no `g` script** and there is no root `nest-cli.json`, because `domains/*` and `libs/*` are plain workspace packages and not Nest CLI "libraries". Domain code lives in `domains/`, so write it by hand following the layout of an existing domain (next section). Use `nest g` inside an app only for code that belongs to that app.
- Generated gRPC types come from `bun run proto:gen` and Drizzle migrations from `bun run db:generate`. Never edit either output by hand, apart from the one-line `CREATE SCHEMA IF NOT EXISTS` edit of a domain's first migration ([migrations](#database-migrations-postgres--drizzle)).

## Guide: add a new domain module

Example: an `orders` bounded context that starts inside the monolith. Use `domains/billing` as the template: it is the smallest domain with every layer, a contracts package, its own config namespace and its own Postgres migration set.

**1. Create the domain package and its contracts package:**

```text
domains/orders/
├── package.json          # copy domains/billing/package.json, rename to @domain/orders
├── tsconfig.json         # copy domains/billing/tsconfig.json as is
├── drizzle.config.ts     # copy domains/billing/drizzle.config.ts (schema file, out folder, orders.__drizzle_migrations)
├── README.md
├── contracts/            # @domain/orders-contracts: the context's published language
│   ├── package.json      # copy domains/billing/contracts/package.json, rename to @domain/orders-contracts
│   ├── tsconfig.json     # copy domains/billing/contracts/tsconfig.json (extends ../../../tsconfig.base.json)
│   └── src/
│       ├── index.ts                  # barrel: ORDERS_GRPC_PACKAGE, ORDER_PLACED_EVENT, payload types
│       ├── proto/orders/v1/orders.proto
│       ├── generated/orders/v1/      # ts-proto output (bun run proto:gen), never edited by hand
│       ├── grpc/                     # ORDERS_GRPC_PACKAGE: GrpcPackageSpec
│       └── events/                   # ORDER_PLACED_EVENT: EventContract<OrderPlacedPayload>
└── src/
    ├── index.ts                    # the public API (barrel)
    ├── orders.constants.ts         # error codes, tokens
    ├── orders-core.module.ts       # handlers, relays, repositories
    ├── orders-api.module.ts        # forLocal() / forRemote()
    ├── domain/                     # aggregates, domain events, errors (DomainException subclasses)
    ├── application/                # commands/, queries/ (+ handlers), ports/ (abstract classes), repositories/ (abstract)
    ├── infrastructure/             # persistence/ (*.schema.ts, migrations/), adapters/local|grpc, scheduling/
    ├── presentation/               # http/ (controllers + DTOs), graphql/ (resolvers, models), grpc/, kafka consumers
    └── testing/                    # optional ./testing subpath: in-memory fakes for the apps' e2e suites
```

In both `package.json` files, keep the `exports` block exactly as in billing (the `@repo/source` → `src`, `default` → `dist` pair; add a `./testing` entry like `@domain/identity`'s only if you ship fakes) and the same scripts: `build`/`typecheck`/`test`/`clean`, plus `db:generate`/`db:studio` in the domain (pick a free studio port) and `proto:gen`/`proto:lint` in the contracts package. Rename the Vitest projects (`--project orders`, `--project orders-contracts`). **Declare every import**: `@platform/*` and `@domain/<x>-contracts` packages as `workspace:*`, third-party packages as `catalog:` (the versions live once, in the root `catalog`). A domain depends on another domain **only through its contracts package** (`@domain/identity-contracts`, never `@domain/identity`). A contracts package depends only on `@platform/contracts` and third-party packages. A `./testing` subpath (`@domain/identity/testing`, `@platform/auth/testing`) is imported only by specs and `test/` code. `scripts/check-boundaries.mjs` fails otherwise, and Biome's `noUndeclaredDependencies` catches undeclared imports.

**2. Link it.** Add `"@domain/orders": "workspace:*"` to the consuming app's `dependencies` (`apps/monolith/package.json`). Add `"@domain/orders-contracts": "workspace:*"` to every package that calls the context over gRPC or consumes its events. Run `bun install`. Nothing else needs registering:

- the workspaces cover `domains/*` and `domains/*/contracts`;
- Vitest makes both packages projects (`orders`, `orders-contracts`), and the root `tsconfig.json` includes both;
- `scripts/check-boundaries.mjs` checks the names (`@domain/orders`, `@domain/orders-contracts`) and the rules above;
- Lerna/Nx find the packages through the workspaces;
- commitlint accepts `orders` and `orders-contracts` as scopes.

**3. Write the contracts.**

- Put `orders.proto` under `contracts/src/proto/orders/v1/` and run `bun run proto:gen`. The `proto:gen`/`proto:lint` scripts you copied run buf from the package folder with the shared policy and ts-proto template of `libs/contracts` (`buf.yaml`, `buf.gen.yaml`); the root `proto:gen` and `proto:lint` run them in every `domains/*/contracts` package.
- Export the gRPC package spec (`ORDERS_GRPC_PACKAGE`, a `GrpcPackageSpec`) and one `EventContract` per Kafka topic (`ORDER_PLACED_EVENT = defineEventContract('orders.order-placed.v1', orderPlacedPayload)`).
- `@platform/transport` takes these values, never names: `GrpcClientsModule.register({ spec, url })`, `connectGrpcServer(app, [ORDERS_GRPC_PACKAGE])`, `@KafkaEventPattern(ORDER_PLACED_EVENT)`, `new ParseEventEnvelopePipe(ORDER_PLACED_EVENT)` and `KafkaProducer.publish(ORDER_PLACED_EVENT, payload, { key })`.
- Add the topic and its `.dlq` to `docker/kafka/topics.txt` (see [Kafka topics](#kafka-topics)).

**4. Write the layers** in dependency order: domain → application → infrastructure → presentation.

- Commands and queries extend `Command<T>` / `Query<T>` from `@nestjs/cqrs`. Handlers live next to them.
- Presentation depends **only on ports** (`abstract class OrdersPort`). Ports return the contracts package's types, so a local adapter and a later gRPC adapter return identical shapes.
- Errors are subclasses of the concrete `DomainException`s in `@platform/common` (see `domains/billing/src/domain/billing.errors.ts`).
- Integration events are published after the transaction commits, from a relay (see `domains/billing/src/application/relays/payment-succeeded.relay.ts`). There is no transactional outbox yet (a known follow-up).

**5. Persistence (Postgres).** The context owns a Postgres schema and a migration history:

- declare the tables in `src/infrastructure/persistence/orders.schema.ts` on an exported `ordersPgSchema = pgSchema('orders')`, and export an `ordersSchema` object;
- `domains/orders/drizzle.config.ts` (step 1) reads that schema file, writes to `src/infrastructure/persistence/migrations` and records applied files in `orders.__drizzle_migrations` (`schemaFilter: ['orders']`, `migrations: { schema: 'orders', table: '__drizzle_migrations' }`). The separate table matters: drizzle applies only the files newer than the **last** row of its table, so a shared table would let one domain skip another's files;
- export `ordersMigrations`, a `DatabaseMigrationSet`, from `src/infrastructure/persistence/orders.migrations.ts` (copy `billing.migrations.ts` and its spec);
- start the history with `bun run --filter @domain/orders db:generate --name init`, change the first statement of the new `0000_init.sql` to `CREATE SCHEMA IF NOT EXISTS "orders";`, and commit the SQL plus the `meta/` snapshot. Later changes: `bun run db:generate` (it runs every domain's config);
- in each app that owns the data, merge the schema (`const DATABASE_SCHEMA = { ...identitySchema, ...billingSchema, ...ordersSchema }` in `apps/monolith/src/app.module.ts`) and add `ordersMigrations` to the app's `src/database.migrations.ts`, then extend that app's `src/database.migrations.spec.ts` (`apps/monolith/src/database.migrations.spec.ts` pins the ordered list of schemas). `DatabaseModule.forRootAsync({ schema, migrations: DATABASE_MIGRATIONS })` and `src/migrate.ts` both read that list: the platform set always runs first, then the sets in array order, under one advisory lock. See [migrations](#database-migrations-postgres--drizzle).

**6. Modules.** Copy the billing pattern:

```ts
// orders-core.module.ts: what the owning process runs
@Module({
  providers: [
    CreateOrderHandler,
    ListOrdersHandler,
    { provide: OrdersRepository, useClass: DrizzleOrdersRepository },
  ],
})
export class OrdersCoreModule {}

// orders-api.module.ts: the edge (REST + GraphQL); only the port binding differs
@Module({})
export class OrdersApiModule {
  static forLocal(): DynamicModule {
    return {
      module: OrdersApiModule,
      imports: [OrdersCoreModule],
      controllers: [OrdersController],
      providers: [OrdersResolver, { provide: OrdersPort, useClass: OrdersLocalAdapter }],
      exports: [OrdersPort],
    };
  }
}
```

**7. Wire the app.** Import `OrdersApiModule.forLocal()` in `apps/monolith/src/app.module.ts`, after `AuthModule`, `AppThrottlerModule` and `AppGraphqlModule` (the import-order comment there explains why). Never import the Core module a second time.

**8. Configuration.** If the context needs settings, define its own namespace inside the domain, next to the code that reads it. Billing's `stripe.config.ts` is the model: `defineConfigNamespace('orders', schema)` from `@platform/config`, where the schema is a `z.object({ ... })` keyed by the env var names.

- Load it with `ConfigModule.forFeature(ordersConfig)` in the module that injects it, and inject it with `@Inject(ordersConfig.KEY)`.
- Document every variable in the root `.env.example`. `node scripts/check-env-example.mjs` reads `libs/config/src/namespaces` and every `domains/*/src/**/*.config.ts`, and fails on an undocumented or unknown variable.
- A service's `test/env-example.spec.ts` passes the domain namespaces it loads: `validateAllEnv(env, [ordersConfig])`.
- `@platform/config` registers platform namespaces only: a domain namespace is always loaded and validated explicitly, as above.
- Add a row to the "Which app loads which namespace" table in [CONFIGURATION.md](CONFIGURATION.md#which-app-loads-which-namespace).

**9. Mail (optional).** A context that sends mail owns its templates: a `templates/` folder of `*.hbs` files exported as `ORDERS_MAIL_TEMPLATES_DIR`, a template → context map and a builder (`defineMail<OrdersMailContextMap>()`). The app that delivers the mails registers the folder: `AppMailerModule.forRootAsync({ templateDirs: [NOTIFICATIONS_MAIL_TEMPLATES_DIR, ORDERS_MAIL_TEMPLATES_DIR] })`. A template name must be unique across the registered folders (boot fails on a duplicate). See `domains/notifications/src/application/mail/notifications-mail.ts` and `domains/notifications/src/infrastructure/mail/`.

**10. Tests.** Write unit specs next to the code (`*.spec.ts`) and an e2e spec in `apps/monolith/test/*.e2e-spec.ts`, using fakes at the network edges. If the apps need the context faked, export the fakes from a `./testing` subpath (see `@domain/identity/testing`). See [TESTING.md](TESTING.md). Then run `bun run check && bun run test`.

## Guide: extract a module into a new microservice

This continues the `orders` example: the context moves into its own `orders-service`, and the gateway calls it over gRPC. The monolith keeps `OrdersApiModule.forLocal()`, so both topologies keep working. Copy `billing` and `billing-service` at each step.

```mermaid
flowchart LR
  P[proto in domains/orders/contracts] --> G[bun run proto:gen]
  G --> R[ORDERS_GRPC_PACKAGE + orders client config]
  R --> S[OrdersGrpcModule + controller]
  S --> A[apps/orders-service]
  R --> C[OrdersGrpcAdapter + forRemote]
  C --> W[gateway imports OrdersApiModule.forRemote]
  A --> D[compose service + CI image matrix]
```

**1. Contract.** Add the service to `domains/orders/contracts/src/proto/orders/v1/orders.proto` (`package orders.v1; service OrdersService { … }`). Timestamps use `google.protobuf.Timestamp`, and int64 fields arrive as decimal strings. Then:

```bash
bun run proto:lint   # buf lint of every contracts package (STANDARD minus two response-naming rules)
bun run proto:gen    # buf generate + libs/contracts/scripts/proto-esm-fix.mjs (needs `node` on PATH)
```

Commit `domains/orders/contracts/src/generated/**`. CI regenerates it and fails on any diff. The contracts barrel re-exports the generated module flat and as a namespace (`export * as ordersV1 from './generated/orders/v1/orders.pb.js'`), in case a later `v2` reuses message names.

**2. Package spec.** Export `ORDERS_GRPC_PACKAGE` (a `GrpcPackageSpec`, in `contracts/src/grpc/orders.grpc-package.ts`) from the contracts package, the way `@domain/billing-contracts` exports `BILLING_GRPC_PACKAGE`. It holds:

- the proto package, folder and path;
- the service names, value-imported from the generated module so they cannot drift from the proto (the import also registers the Timestamp ↔ Date wrapper);
- the client token;
- the idempotent methods, which are retried on `UNAVAILABLE`.

**3. Client target.** Add `domains/orders/src/infrastructure/adapters/grpc/orders-grpc-client.config.ts`, an `ordersGrpcClientConfig` namespace reading `ORDERS_GRPC_URL` (copy `billing-grpc-client.config.ts`). `OrdersApiModule.forRemote()` reads it, as `BillingApiModule.forRemote()` reads billing's. Document the variable in the root `.env.example` and in `apps/gateway/.env.example`, and add an `ordersGrpcClient` row (gateway) to the "Which app loads which namespace" table in [CONFIGURATION.md](CONFIGURATION.md#which-app-loads-which-namespace).

**4. Server side, in the domain.** Add `OrdersGrpcController` under `presentation/grpc/` and `OrdersGrpcModule` (imports `OrdersCoreModule` and declares the controller). The generated types come from `@domain/orders-contracts`:

```ts
@GrpcController() // Controller + DomainException → gRPC status filter + per-call CLS context
@OrdersServiceControllerMethods() // generated by ts-proto
export class OrdersGrpcController implements OrdersServiceController {
  constructor(private readonly queryBus: QueryBus) {}
  getOrder(
    @Payload(new ZodRpcValidationPipe(getOrderRpcSchema)) req: GetOrderRequest,
  ): Promise<Order> {
    return this.queryBus.execute(new GetOrderQuery(req.id)); // Timestamp fields MUST be Date objects
  }
}
```

**5. Client side, in the domain.** Add `OrdersGrpcAdapter implements OrdersPort` under `infrastructure/adapters/grpc/`, based on `BillingGrpcAdapter`: inject the client registered for `ORDERS_GRPC_PACKAGE` (`@Inject(ORDERS_GRPC_PACKAGE.clientToken)`), `grpcConfig.KEY` and `GrpcCircuitBreakers`, and wrap every call in `grpcCall(…, { timeoutMs, operation, breaker })`. proto-loader decodes absent message fields as `null`, so normalise them the way `normalizePayment` does. Add the remote binding by copying `BillingApiModule.forRemote()`: `GrpcClientsModule.register({ spec: ORDERS_GRPC_PACKAGE, url: ordersGrpcClientConfig.parse().url })`.

**6. The service app.** Copy `apps/billing-service` to `apps/orders-service` and change:

- `package.json`: `"name": "@app/orders-service"`, the Vitest project names in `test`/`test:e2e`, and the dependencies (`@domain/orders`, …).
- `.env.example`: `SERVICE_NAME=orders-service`, `PORT=3004`, `GRPC_URL=0.0.0.0:50054`, `KAFKA_GROUP_ID=orders-service`, `DATABASE_RUN_MIGRATIONS=true`.
- `src/instrument.ts`: `startTracing({ serviceName: 'orders-service' })`.
- `src/app.module.ts`: the global modules the core needs, then `OrdersGrpcModule` and `provideCommonEnhancersAsync(…)`. The global modules are `AppConfigModule.forRoot()`, `ConfigModule.forFeature(grpcConfig)`, `ObservabilityModule.forRoot({ healthContributors })`, `CqrsModule.forRoot()`, `ScheduleModule.forRoot()` (if the core has crons), `DatabaseModule.forRootAsync({ schema: ordersSchema, migrations: DATABASE_MIGRATIONS })`, `RedisModule.forRootAsync()` and `KafkaProducerModule.forRootAsync()`.
- `src/database.migrations.ts` (`DATABASE_MIGRATIONS = [ordersMigrations]`) and `src/migrate.ts`, the release-job migration CLI (`import 'reflect-metadata'`, then `await runMigrationsCli(DATABASE_MIGRATIONS)`), with the `db:migrate` / `db:migrate:dev` scripts: copy them from `apps/billing-service`. The image build fails when an app with a `src/migrate.ts` has no `dist/migrate.js`.
- `src/main.ts`: `connectGrpcServer(app, [ORDERS_GRPC_PACKAGE])` after `createServiceApp(AppModule)` and before `app.startAllMicroservices()` and `listen(app)`.
- The copied specs, which pin billing's values: `test/env-example.spec.ts` (`validateAllEnv(env, [ordersConfig])` instead of `[stripeConfig]`, and the pinned service name and consumer group `orders-service`, port `3004` and gRPC bind `0.0.0.0:50054`), `src/database.migrations.spec.ts` (`['orders']`), and `test/app.e2e-spec.ts` with `test/support/` (rewrite them for the orders gRPC service).

Add root scripts by copying `dev:billing` (`"dev:orders": "bun run setup:env && bun run --filter @app/orders-service dev"`), and append the service to `dev:microservices`.

**7. Gateway.** Replace or add `OrdersApiModule.forRemote()` in `apps/gateway/src/app.module.ts`, and add `@domain/orders` to the gateway's dependencies.

**8. Docker and CI.**

- The `Dockerfile` needs no change (`docker build --build-arg APP=orders-service .`).
- Add an `orders-service` service with `profiles: [microservices]` to `docker-compose.yml` (copy `billing-service`).
- Set `ORDERS_GRPC_URL: orders-service:50051` on the gateway. Inside the network every service binds `GRPC_URL: 0.0.0.0:50051`; only the published host port differs, for example `127.0.0.1:${ORDERS_GRPC_HOST_PORT:-50054}:50051`.
- Add `orders-service` to the `image` job matrix in `.github/workflows/ci.yml`.

Known limits that apply to extracted services:

- **Image size.** Today the gateway imports whole domain packages, and the Dockerfile builds every domain and lib (`bun run --filter "./libs/*" --filter "./domains/*" …`). Per-domain `@domain/<x>/api` subpath exports, which would let the gateway image drop the core and persistence code, are a known follow-up.
- **Events.** Integration events are publish-after-commit. A crash between commit and publish loses the event. A transactional outbox is a known follow-up.

## Conventions and DI pitfalls

**ESM rules.** Every package is `"type": "module"` with `module: NodeNext`.

- Relative imports end in `.js`, even from `.ts` files: `import { X } from './x.js'`.
- Use `import.meta.dirname`, never `__dirname`.
- JSON imports need `with { type: 'json' }`.

**`import type`: two opposite rules.** `verbatimModuleSyntax: true` keeps every value import as a real ESM link, and Nest DI reads constructor types at runtime through `emitDecoratorMetadata`. That gives two rules:

| Symbol                                                                                                                            | Import as                               | What breaks otherwise                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A class injected by constructor type (`private readonly bus: CommandBus`), a DTO in a handler signature, or a GraphQL model/input | **value** (`import { CommandBus }`)     | The metadata becomes `Object`. You get `Nest can't resolve dependencies of X (?)`, ValidationPipe silently skips the DTO, and GraphQL cannot infer types. |
| An interface or type alias used in a decorated signature (`GrpcConfig`, `FastifyReply`, `ClientGrpc`)                             | **type** (`import type { GrpcConfig }`) | `TS1484`, or a runtime `SyntaxError: … does not provide an export named …`.                                                                               |

Biome's `useImportType` is **off** because it cannot see decorators. ESLint's `@typescript-eslint/consistent-type-imports` (`fixStyle: separate-type-imports`) is decorator-aware and enforces the rule. `bun run g` runs it with `--fix`. For injected values that are interfaces, use `@Inject(token)` with an `import type` (for example `@Inject(grpcConfig.KEY) private readonly config: GrpcConfig`).

**`reflect-metadata` first.** `import 'reflect-metadata'` is the first line of every `main.ts`. Vitest preloads it with `setupFiles`. The generated `<Svc>ControllerMethods()` decorators need it too.

**Circular imports.** ESM evaluates modules in order, so a class taking part in an import cycle can still be in its temporal dead zone when the decorator metadata references it (`ReferenceError: Cannot access 'X' before initialization`). Break the cycle. If you can't, wrap the type:

```ts
import { forwardRef, Inject } from '@nestjs/common';
import type { WrapperType } from '@platform/common'; // libs/common/src/types/utility.types.ts
constructor(@Inject(forwardRef(() => UsersService)) private readonly users: WrapperType<UsersService>) {}
```

**Context-aware enhancers.** Hybrid apps attach gRPC and Kafka servers with `inheritAppConfig: true`, so every global `APP_GUARD`/`APP_INTERCEPTOR`/`APP_PIPE`/`APP_FILTER` also wraps RPC handlers. Every enhancer must branch on the transport with `getContextType(ctx)`, which returns `'http' | 'graphql' | 'ws' | 'rpc'` (`libs/common/src/context/execution-context.util.ts`). It is a typed `getType()` that knows `'graphql'` without importing `@nestjs/graphql`. Use `getRequest(ctx)` to get the platform request. It returns `undefined` for `rpc`, so never assume `switchToHttp()`. The `provideCommonEnhancers*()` helpers (`libs/common/src/providers/common-enhancers.ts`) already do this. Transport-specific error mapping is controller-scoped:

- `@GrpcController()` for gRPC,
- `@KafkaConsumerController()` for Kafka. It includes `KafkaDeadLetterFilter`. A Kafka handler must not let an error escape that filter: it would be redelivered forever.

**Errors.** Domain and application code throw `DomainException` subclasses (`libs/common/src/errors/domain.exception.ts`), never `HttpException`. Each transport maps them:

- HTTP: RFC 9457 `application/problem+json`
- gRPC: status + `x-error-code` trailer
- GraphQL: `extensions.code`
- WebSocket: `exception` event

```ts
export class EmailAlreadyTakenException extends DomainConflictException {
  override readonly code = 'EMAIL_TAKEN';
}
```

**Configuration.** Read settings only through config namespaces, a platform one from `@platform/config` or your domain's own built with `defineConfigNamespace`: `ConfigModule.forFeature(mailConfig)` + `@Inject(mailConfig.KEY) cfg: MailConfig`. Each namespace is a zod schema (`defineConfigNamespace`), validated at boot. `process.env` is not read outside `libs/config`, with documented exceptions: the OpenTelemetry preload (`libs/observability/src/otel.ts`), each domain's `drizzle.config.ts` and test setup.

**Other rules.**

| Rule                                                                                                       | Why                                                                |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `lodash-es` named imports (`import { isNil, mapValues } from 'lodash-es'`), never `lodash`                 | `lodash` is CJS. Named ESM imports fail at runtime.                |
| No `console.*`. Use Nest `Logger` (pino-backed).                                                           | Structured JSON logs, redaction, correlation ids.                  |
| No `any`, no floating promises (`no-floating-promises`, `no-misused-promises`)                             | Type-aware ESLint enforces both.                                   |
| Ids are uuid v7 via `generateId()` (`@platform/common`)                                                    | Time-ordered primary keys.                                         |
| No REQUEST-scoped providers on hot paths. Use `nestjs-cls` for request context and per-request DataLoaders | Request scope re-instantiates the provider graph on every request. |
| Keyset (cursor) pagination, prepared statements                                                            | Stable latency under load. See [PERFORMANCE.md](PERFORMANCE.md).   |

## Database migrations (Postgres / Drizzle)

Each Postgres-backed context owns a Postgres **schema** and its own **migration history**:

| Set      | Schema     | History (`NNNN_name.sql` + `meta/`)                          | drizzle-kit config                   | Bookkeeping table               |
| -------- | ---------- | ------------------------------------------------------------ | ------------------------------------ | ------------------------------- |
| platform | `app`      | `libs/database/src/platform/migrations` (hand-written)       | none                                 | `app.__drizzle_migrations`      |
| identity | `identity` | `domains/identity/src/infrastructure/persistence/migrations` | `domains/identity/drizzle.config.ts` | `identity.__drizzle_migrations` |
| billing  | `billing`  | `domains/billing/src/infrastructure/persistence/migrations`  | `domains/billing/drizzle.config.ts`  | `billing.__drizzle_migrations`  |

- Tables are declared on an exported `pgSchema('<x>')` in the domain's `*.schema.ts`, with `casing: 'snake_case'`
  (the casing the runtime `drizzle()` uses). Raw SQL qualifies names (`identity.users`).
- One bookkeeping table per set is mandatory: drizzle's migrator only applies files newer than the **last** row of
  its table, so two histories sharing a table would silently skip the older one's files. `DatabaseModule` rejects two
  sets with one table.
- **Order.** `DatabaseModule.forRootAsync({ schema, migrations })` and each app's `src/migrate.ts` apply the platform
  set first (it cannot be left out), then the app's sets in array order, all under one advisory lock. Each app lists
  its sets once, in `src/database.migrations.ts`: the monolith `[identityMigrations, billingMigrations]`,
  identity-service `[identityMigrations]`, billing-service `[billingMigrations]`.

| Command                                  | What it does                                                                                                                                                    |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run db:generate`                    | `drizzle-kit generate` in every domain that has a config: a new SQL migration from that domain's schema diff. Review the SQL, then commit it with `meta/`.      |
| `bun run db:migrate`                     | The monolith's `src/migrate.ts` from **sources** (swc-node, `@repo/source`) with the root `.env` and `apps/monolith/.env`: the platform set, identity, billing. |
| `bun run --filter @app/<app> db:migrate` | The same from the app's `dist/migrate.js` (needs `bun run build`), with that app's sets. This is the production release job. See [DOCKER.md](DOCKER.md).        |
| `bun run db:studio`                      | Drizzle Studio per domain against `DATABASE_URL`: identity on port 4983, billing on 4984.                                                                       |

Notes:

- `DATABASE_RUN_MIGRATIONS=true` (set in the per-app `.env` of the monolith, identity-service and billing-service) applies the sets at boot under a Postgres **advisory lock**, so replicas and services that boot together apply each file once. In production, set it to `false` and run each app image's migrate job.
- Migrations are forward-only. Write expand/contract changes (add a nullable column → backfill → enforce) so the old and new versions of the code can run side by side during a rollout.
- One domain at a time: `bun run --filter @domain/identity db:generate --name <change>`. A hand-written domain migration: add `--custom` for an empty file registered in that domain's journal.
- **A new history** starts with `bun run --filter @domain/<x> db:generate --name init`. Change its first statement from `CREATE SCHEMA "<x>";` to `CREATE SCHEMA IF NOT EXISTS "<x>";`: the migrator creates the schema first, for `<x>.__drizzle_migrations`. It is the only hand edit of generated SQL, and the domain's `*.migrations.spec.ts` checks it.
- SQL that belongs to no domain (extensions; grants and functions from B3) goes in the platform set: add `NNNN_name.sql` and its `meta/_journal.json` entry by hand ([libs/database/README.md](../libs/database/README.md#platform-migration-set)).
- CI runs `bun run db:generate` and fails if it produces a diff or a new untracked file under `domains/*/src/infrastructure/persistence/migrations`. A `*.schema.ts` change without its migration cannot merge.

## Cassandra CQL migrations

The notifications inbox lives in Cassandra. Its schema is versioned as CQL files that ship with the lib (SWC `copyFiles` copies `.cql` into `dist`):

```text
domains/notifications/src/infrastructure/persistence/migrations/
├── 001_create_notifications.cql
└── 002_create_notification_recipients.cql
```

- The file name is `NNN_name.cql`. A file can hold several statements, and **each one must be idempotent** (`CREATE TABLE IF NOT EXISTS …`). `{keyspace}` is substituted if you want fully qualified names.
- The lib registers its folder (`notificationsCassandraMigrations = { dir: … }`), and the app passes it to `CassandraModule.forRootAsync({ migrations: [notificationsCassandraMigrations] })`.
- Migrations run **at boot only** when `CASSANDRA_RUN_MIGRATIONS=true` (the default). There is no standalone CLI. In order, boot:
  1. creates the keyspace if it is missing (it never alters an existing one),
  2. reads `<keyspace>.schema_migrations`,
  3. claims each pending version with an LWT `INSERT … IF NOT EXISTS`, so only one replica applies it.
- They are forward-only. Editing an applied file only logs a warning. Add a new numbered file instead.
- A crashed instance can leave a claim stuck in `applying`. Boot then times out after 2 minutes and prints the `DELETE` that releases the claim.

Details: [`libs/cassandra/README.md`](../libs/cassandra/README.md).

## Kafka topics

Integration events use topics named `<context>.<event>.v<major>`, plus a `.dlq` topic for each one. Today there are three:

- `identity.user-registered.v1`
- `billing.payment-succeeded.v1`
- `notifications.notification-created.v1`

Broker auto-creation is **off**, locally as in production. Adding a topic touches the contracts and the provisioning file:

| Where                                                        | What                                                                                                                                                                       |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `domains/<context>/contracts/src/events/<context>.events.ts` | The zod payload schema (a tolerant reader: unknown keys are stripped) and its contract: `defineEventContract('<context>.<event>.v1', schema)`. The `.dlq` name is derived. |
| `docker/kafka/topics.txt`                                    | `name:partitions:replication-factor[:config=value]` for the topic **and** its `.dlq`. The one-shot `kafka-init` service creates them on `docker compose up`.               |

Check the provisioning file against the contracts with `bun run build && node scripts/docker/check-kafka-topics.mjs`. The script imports every built `domains/*/contracts` package, and CI runs it. After editing `topics.txt`, re-run `bun run docker:infra` so `kafka-init` creates the new topic idempotently.

Producing and consuming:

- Producers call `KafkaProducer.publish(contract, payload, { key })` with the producer's contract (`PAYMENT_SUCCEEDED_EVENT`). Key by user id so each user's events stay in order.
- Consumers are `@KafkaConsumerController()` classes with `@KafkaEventPattern(contract)` and `new ParseEventEnvelopePipe(contract)`, the contract imported from the producer's contracts package.
- The consumer group comes from `KAFKA_GROUP_ID` in the app's `.env`. Use a distinct group per consuming service, and the same group for every replica of that service.
- A breaking payload change ships as a new `.v2` topic, consumed side by side with `.v1`. Additive changes stay on the same topic.
- Dead letters can be replayed with `node --env-file=.env libs/transport/scripts/kafka-dlq-replay.mjs <topic> [--dry-run]` (after `bun run build`).

## Troubleshooting

| Symptom                                                                                  | Cause and fix                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `EADDRINUSE :::3000`, or every service binds 3000/50051                                  | Either `apps/<app>/.env` is missing (run `bun run setup:env`), or the monolith and the gateway are both running. Both bind 3000.                                                                                                                 |
| `Nest can't resolve dependencies of X (?)`, or a DTO is not validated                    | An injected class or a DTO was imported with `import type`. Import it as a value. See [DI pitfalls](#conventions-and-di-pitfalls).                                                                                                               |
| `TS1484: 'X' is a type and must be imported using a type-only import`                    | The opposite case: an interface or type alias imported as a value under `verbatimModuleSyntax`. `bun run lint:fix` repairs it.                                                                                                                   |
| `ReferenceError: Cannot access 'X' before initialization`                                | An ESM import cycle reached by decorator metadata. Break the cycle, or use `forwardRef(() => X)` + `WrapperType<X>`.                                                                                                                             |
| `Cannot find module …/dist/index.js` when starting an app                                | The process ran without `--conditions=@repo/source`, for example the `start` script or a bare `node`, and libs are not built. Use `bun run dev`, or run `bun run build` first.                                                                   |
| gRPC Timestamps arrive as `{ seconds, nanos }`                                           | The process imported only _types_ from a contracts package, or a second `protobufjs` copy exists. Import any value from it (every `<X>_GRPC_PACKAGE` does), and keep the single `protobufjs@7` from the root `overrides`.                        |
| gRPC server error `object expected` on a Timestamp field                                 | The handler returned an ISO string. Return a `Date`.                                                                                                                                                                                             |
| `instanceof` fails across packages, or `ClientsModule` is registered twice               | Two copies of a `@nestjs/*` package. Keep `linker = "hoisted"` in `bunfig.toml` and do not add per-package `node_modules`.                                                                                                                       |
| A Kafka consumer fails at boot with an unknown topic, or "coordinator is loading" errors | The topic is missing from `docker/kafka/topics.txt`, or infra was started without the init job. Run `bun run docker:infra`. A few "coordinator is loading" warnings on a fresh broker are normal.                                                |
| A Kafka message is redelivered forever                                                   | An error escaped the handler. Consumers must use `@KafkaConsumerController()`, which dead-letters the failure to `<topic>.dlq` and commits the offset.                                                                                           |
| Cassandra: `NoHostAvailableError`, or every query fails                                  | `CASSANDRA_LOCAL_DC` must equal the node's data center (`datacenter1` in compose). Otherwise the driver ignores the node. Cassandra also needs about a minute on first start.                                                                    |
| Boot hangs about 2 min, then fails on a CQL migration                                    | A crashed instance left a claim in `applying`. Run the `DELETE` printed in the log, then restart.                                                                                                                                                |
| `bun run proto:gen` fails with `env: node: No such file or directory`                    | `protoc-gen-ts_proto` is a `#!/usr/bin/env node` script. Put Node 24 on `PATH` (`nvm use`).                                                                                                                                                      |
| CI "Generated artefacts drift" fails                                                     | A `.proto` or `*.schema.ts` changed without a regenerated output. Run `bun run proto:gen` / `bun run db:generate` and commit `domains/*/contracts/src/generated` / `domains/<domain>/src/infrastructure/persistence/migrations`.                 |
| Users or payments created before the per-domain schemas are missing                      | The tables moved from `public` to the `identity` and `billing` schemas with fresh histories; the old `public` tables are orphaned. Reset once: `docker compose --profile '*' down -v` (deletes every local volume), then `bun run docker:infra`. |
| CI "Config drift" fails                                                                  | A config schema reads a variable that the root `.env.example` does not list, or `topics.txt` and the contracts disagree. Run `node scripts/check-env-example.mjs` (and the topics check after a build).                                          |
| Latency rises sharply under load in a container (Argon2 login, uploads)                  | `UV_THREADPOOL_SIZE` is above the container's CPU quota. Measured: 16 threads on a 2-CPU cap raised p95 from 36 ms to 304 ms. Keep it ≤ the CPUs the process gets (default 4). See [PERFORMANCE.md](PERFORMANCE.md).                             |
| Stripe checkout or webhook returns errors locally                                        | `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET` are placeholders. Set test keys, then forward webhooks with `stripe listen --forward-to localhost:3000/v1/billing/webhooks/stripe`.                                                                  |
| Presigned upload/download URLs point to an unreachable host or port                      | They are signed for `S3_PUBLIC_ENDPOINT`. On the host, set it next to `S3_ENDPOINT`; for containers on a remapped S3 port, pass `S3_HOST_PORT` to the compose command too (`S3_PUBLIC_ENDPOINT=http://localhost:${S3_HOST_PORT:-9000}`).         |
| A non-JSON `<claude-code-hint … />` line on stderr (billing-service, monolith)           | stripe-node 22 prints it at import when `CLAUDECODE` / `CLAUDE_CODE_CHILD_SESSION` are set (apps launched from Claude Code). Not app output: start the app with `env -u CLAUDECODE -u CLAUDE_CODE_CHILD_SESSION …`.                              |
| `docker build -t img/$app:local` produces a lowercase or odd tag in zsh                  | zsh expands `$app:l`. Quote it: `"img/${app}:local"`.                                                                                                                                                                                            |

Still stuck? Set `LOG_LEVEL=debug` (with `LOG_PRETTY=true` for readable output), check `/health/ready` (it lists each contributor), and see the gotchas in [DOCKER.md](DOCKER.md).

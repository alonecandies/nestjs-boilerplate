# Testing

How the test suite is organised, how to run it and how to write new tests.

All tests run on **Vitest 5** from one root [`vitest.config.ts`](../vitest.config.ts). Workspace libraries
resolve to their TypeScript sources, so nothing has to be built before testing. The default suite
(`bun run test`) needs **no Docker and no running infrastructure**.

See also: [README.md](../README.md) · [DEVELOPMENT.md](DEVELOPMENT.md) · [ARCHITECTURE.md](ARCHITECTURE.md) ·
[PERFORMANCE.md](PERFORMANCE.md) · [DOCKER.md](DOCKER.md) · [`@app/testing`](../libs/testing/README.md)

## Test pyramid

```mermaid
flowchart TB
  int["*.int-spec.ts<br/>real Postgres 18 / Redis<br/>opt-in: INTEGRATION=1"]
  e2e["apps/*/test/*.e2e-spec.ts<br/>real AppModule, fakes at network edges<br/>no Docker"]
  unit["src/**/*.spec.ts, test/**/*.spec.ts<br/>handlers, domain, pipes, guards, adapters"]
  int --> e2e --> unit
```

| Layer       | Files                                                    | What is real                                                                                                                                        | What is fake                                                                                    | Runs by default          |
| ----------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------ |
| Unit        | `src/**/*.spec.ts`, `test/**/*.spec.ts` in every package | the class under test                                                                                                                                | collaborators, usually `createMock<T>()`                                                        | yes                      |
| App e2e     | `apps/<app>/test/*.e2e-spec.ts`                          | the app's `AppModule`, global pipes/guards/filters, HTTP wiring (Fastify via `app.inject()`), and for the services a gRPC server on a loopback port | only network edges: Postgres client, Redis, Kafka, Cassandra, object storage, upstream services | yes                      |
| Integration | `*.int-spec.ts`                                          | Postgres 18 (testcontainers) or Redis                                                                                                               | nothing                                                                                         | no, `INTEGRATION=1` only |

Every app has an e2e spec: `monolith`, `gateway`, `identity-service`, `notifications-service`,
`billing-service`. The services also have `test/env-example.spec.ts`, which checks that the app's
`.env.example` passes every config namespace and does not reuse another service's ports.

The rule for e2e tests: **fake only at the network edge**. Swap the client or port that would open a
socket, and keep repositories, CQRS handlers, enhancers and serialization real. For example,
identity-service runs a real drizzle instance over a fake postgres.js client rather than mocking its
repositories.

## Vitest projects

[`vitest.config.ts`](../vitest.config.ts) builds the project list itself. Every folder under `apps/`
or `libs/` that has a `package.json` becomes a project:

| Project name | Created for                                    | Includes                                        | Timeouts (test / hook) |
| ------------ | ---------------------------------------------- | ----------------------------------------------- | ---------------------- |
| `<name>`     | every lib and app (unit)                       | `src/**/*.spec.ts`, `test/**/*.spec.ts`         | Vitest defaults        |
| `<app>:e2e`  | every app                                      | `test/**/*.e2e-spec.ts`                         | 30 s / 60 s            |
| `<name>:int` | every lib and app, **only if `INTEGRATION=1`** | `src/**/*.int-spec.ts`, `test/**/*.int-spec.ts` | 120 s / 180 s          |

Examples: `redis`, `identity`, `gateway`, `gateway:e2e`, `identity-service:e2e`, `database:int`,
`identity:int`. A new package gets its projects automatically. You do not need to register it.

Shared settings: `globals: true`, `setupFiles: ['reflect-metadata']`, `pool: 'forks'` (Nest apps hold
sockets and timers, and forks isolate them most reliably), `clearMocks` and `restoreMocks`. Coverage
uses the `v8` provider over `apps/*/src/**` and `libs/*/src/**`. It skips generated code, specs,
`index.ts` and `main.ts`, and writes the `text-summary`, `html` and `lcov` reporters to `coverage/`.

## Commands

| Command                                                | Runs                                                                                                     |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `bun run test`                                         | `vitest run`: every unit **and** e2e project (integration projects do not exist without `INTEGRATION=1`) |
| `bun run test:watch`                                   | `vitest` in watch mode                                                                                   |
| `bun run test:e2e`                                     | `vitest run --project '*:e2e'`: the five app e2e suites only                                             |
| `bun run test:cov`                                     | `vitest run --coverage`: unit + e2e with v8 coverage                                                     |
| `bun run test:int`                                     | `INTEGRATION=1 vitest run --project '*:int'`: integration specs (needs Docker and Redis, see below)      |
| `bunx vitest run --project redis`                      | one project                                                                                              |
| `bunx vitest run --project 'identity*'`                | glob over project names (here `identity`, `identity-service` and `identity-service:e2e`)                 |
| `bunx vitest run libs/auth/src/guards`                 | a path filter, within all matching projects                                                              |
| `INTEGRATION=1 bunx vitest run --project identity:int` | one integration project                                                                                  |
| `bun run --filter @app/gateway test` / `test:e2e`      | the package's own script (`vitest run --config ../../vitest.config.ts --project gateway[:e2e]`)          |

`bun run check` is the static gate (Biome, ESLint, Prettier, `tsc`). It does **not** run tests, so run
`bun run test` too before pushing. CI ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)) runs
`bun run test` in the quality job and `bun run test:int` in a separate `integration` job. That job has
Docker for testcontainers and a `redis` service container with `REDIS_URL=redis://localhost:6379`.

## Writing tests

### Toolbox

| Helper                                                                                                             | Import from                                                     | Use it for                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createFastifyTestApp(builder, configure?, options?)`                                                              | `@app/testing`                                                  | Compiles a `TestingModuleBuilder` into a **ready** Fastify app with URI versioning (default `v1`). It binds no port, so drive it with `app.inject()`                                      |
| `createMock<T>(overrides?)` / `Mocked<T>`                                                                          | `@app/testing`                                                  | Proxy auto-mock. Every member you touch is a cached `vi.fn()`. Also works with `builder.useMocker(() => createMock())`                                                                    |
| `InMemoryRedis` (`.asRedis()`)                                                                                     | `@app/redis/testing`                                            | ioredis stand-in: strings with PX/EX, counters, pub/sub across `duplicate()`, and the package's Lua throttle script emulated in JS                                                        |
| `FakeKafkaProducer`                                                                                                | `@app/transport`                                                | Validates envelopes like the real `KafkaProducer`, then records them. Read them with `published(topic)`, `envelopes(topic)` or `records`; `failNextWith(err)` makes the next publish fail |
| `InMemoryStorageService`                                                                                           | `@app/storage`                                                  | `StorageService` held in memory, with the real driver contract and fake `memory://` presigned URLs                                                                                        |
| `makeAuthUser(overrides?)`                                                                                         | `@app/auth`                                                     | A valid `AuthUser` (a regular user by default). Overriding `roles` without `permissions` resolves the permissions from the roles, as production does                                      |
| `createFakePostgres(schema, handler)`                                                                              | `apps/{identity,billing}-service/test/support/fake-postgres.ts` | A **real** drizzle instance over a fake postgres.js client. `handler(sql, params)` returns rows **in SELECT column order**; `executed` logs every query                                   |
| `createFakePostgres`, `createFakeCassandra`, `createFakeQueue`                                                     | `apps/monolith/test/support/fake-infrastructure.ts`             | The monolith's edge fakes                                                                                                                                                                 |
| `createInMemoryIdentityPersistence`                                                                                | `apps/monolith/test/support/in-memory-identity.ts`              | In-memory users and sessions repositories                                                                                                                                                 |
| `createFakeCassandra(handler)`, `InMemoryKafkaServer`                                                              | `apps/notifications-service/test/support/`                      | Fake CQL client, and a Kafka transport strategy that delivers in-process                                                                                                                  |
| `FakeAuthPort`, `FakeUsersPort`, `FakeNotificationsPort`                                                           | `apps/gateway/test/support/fake-upstreams.ts`                   | In-memory upstream services behind the gateway's ports                                                                                                                                    |
| `graphql(query, variables?, headers?)`, `bearer(token)`, `expectProblem(res, status, code?)`, `multipartFile(...)` | `apps/{gateway,monolith}/test/support/http.ts`                  | `inject()` options for `POST /graphql`, an `Authorization` header, an RFC 9457 problem assertion (it also checks that `requestId` matches the header), and a multipart upload body        |

| `startServiceTestApp(builder, { grpc, kafka? })`, `freePort()` | `apps/<service>/test/support/` | Boots a service like `main.ts` does (HTTP wiring, gRPC server on a real loopback port, optional in-process Kafka consumer) |
| `createFakeSql` | `libs/database/test/fake-sql.ts` | postgres.js `Sql` stand-in for module wiring, `@Transactional()`, health and migration-lock unit tests |
| `createFakeCassandraClient` | `libs/cassandra/test/fake-cassandra.ts` | cassandra-driver stand-in for the Cassandra lib's unit tests |
| `InMemoryPaymentsRepository`, `InMemoryStripeEventsRepository` | `libs/billing/test/billing-test.utils.ts` | Billing repositories in memory |

`@app/testing` depends on no other workspace package and imports `vitest`. Import it only from spec
files and `test/**`. `@app/redis/testing` is a separate subpath for the same reason: production code
never loads it.

### A unit test

```ts
// libs/identity/src/application/queries/get-user-by-id/get-user-by-id.handler.spec.ts
import { EntityNotFoundException, generateId } from '@app/common';
import { createMock } from '@app/testing';
import { Test } from '@nestjs/testing';
import { UsersRepository } from '../../persistence/users.repository.js';
import { GetUserByIdHandler } from './get-user-by-id.handler.js';
import { GetUserByIdQuery } from './get-user-by-id.query.js';

const id = generateId();

const users = createMock<UsersRepository>({ findById: async () => null });
const moduleRef = await Test.createTestingModule({
  providers: [GetUserByIdHandler, { provide: UsersRepository, useValue: users }],
}).compile();

await expect(
  moduleRef.get(GetUserByIdHandler).execute(new GetUserByIdQuery(id)),
).rejects.toBeInstanceOf(EntityNotFoundException);
expect(users.findById).toHaveBeenCalledWith(id);
```

### An app e2e test (fakes at the edge)

This is the shape of
[`apps/identity-service/test/app.e2e-spec.ts`](../apps/identity-service/test/app.e2e-spec.ts):

```ts
const postgres = createFakePostgres(identitySchema, (sql) =>
  sql === 'select 1' ? [{ '?column?': 1 }] : [],
);

beforeAll(async () => {
  const grpcUrl = `127.0.0.1:${await freePort()}`;
  // Point every client at a closed port so nothing can reach real infrastructure.
  for (const [k, v] of Object.entries({
    LOG_LEVEL: 'silent',
    GRPC_URL: grpcUrl,
    DATABASE_URL: 'postgres://app:app@127.0.0.1:1/app',
    REDIS_URL: 'redis://127.0.0.1:1',
    KAFKA_BROKERS: '127.0.0.1:1',
  }))
    vi.stubEnv(k, v);

  const builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DRIZZLE)
    .useValue(postgres.db)
    .overrideProvider(REDIS_CLIENT)
    .useValue(new InMemoryRedis().asRedis())
    .overrideProvider(KafkaProducer)
    .useValue(new FakeKafkaProducer({ source: 'identity-service' }));
  app = await startServiceTestApp(builder, { grpc: ['identity'] });
});

afterAll(async () => {
  await app?.close();
  vi.unstubAllEnvs();
});

it('GET /health/live', async () => {
  const res = await app.inject({ method: 'GET', url: '/health/live' });
  expect(res.statusCode).toBe(200);
});
```

In the gateway and monolith suites, the `http.ts` helpers keep requests short:

```ts
const res = await app.inject(graphql('{ me { id email } }', undefined, bearer(accessToken)));
expect(res.json().data.me.email).toBe('ada@example.com');

expectProblem(await app.inject({ method: 'GET', url: '/v1/auth/me' }), 401);
```

The gateway e2e suite ([`apps/gateway/test/support/gateway-e2e-app.ts`](../apps/gateway/test/support/gateway-e2e-app.ts))
uses the same approach. It boots the real gateway `AppModule` with `buildFastifyOptions`,
`configureHttpApp` and `setupApiDocs`, and fakes Redis, the identity and notifications upstreams,
`StorageService` and the GraphQL `PubSub`. `BillingPort` stays real and points at an upstream that is
down, so the suite covers the circuit-breaker and error paths.

### Gotchas

- **`clearMocks: true`**: call history is reset before each test. Assert on calls made in the same
  test, not in `beforeAll`.
- **Env must be set before config is parsed.** Use `vi.stubEnv` in `beforeAll` before you compile the
  module. If imports read the env at module load, set it in a hoisted block instead. The gateway e2e
  does this with `await vi.hoisted(async () => { Object.assign(process.env, GATEWAY_E2E_ENV) })`.
- **`createFastifyTestApp` waits for Fastify `ready()`**. Without that, plugins registered in
  `configure` could race `inject()`. Always `await app.close()` in `afterAll`.
- **Fake rows are positional.** drizzle reads `.values()` arrays, so `createFakePostgres` rows must
  list values in the order of the SELECTed columns. Build them from `getTableColumns(table)` as the
  identity e2e does.
- **The Nest `Logger` is process-static.** `appOptions.logger` of one test app affects the others in
  the same worker.
- `InMemoryRedis` implements only what the libs use. If code needs more of Redis, test it in an
  `*.int-spec.ts`.

## Why SWC and custom resolve conditions

**SWC, not Vite's default transformer.** Nest's dependency injection resolves constructor
parameters by type through `emitDecoratorMetadata`. Vite's default transformers (esbuild/Oxc) do not
emit that metadata. The config uses `unplugin-swc` with legacy decorators, `decoratorMetadata: true`,
`useDefineForClassFields: false` and `keepClassNames`, the same SWC transformer that builds every
package. DI therefore behaves the same in tests and in production, and nobody has to add `@Inject()`
just to make tests pass.

**`ssr.resolve.conditions`.** Vitest (Vite 6 or later) passes these to Node tests as `--conditions`.
The goal is for tests to resolve **exactly** what Node 24 resolves in production, so that no package
loads twice:

| Condition                                                  | Why                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@app/source`                                              | Workspace packages export `"@app/source": "./src/*.ts"` next to `"default": "./dist/*.js"`. Tests (like `tsc` and `bun run dev`) load TS sources, so **no lib build is needed** before testing                                                                                                                                               |
| `module-sync`                                              | Node ≥ 22.10 honours it natively, and dual packages such as graphql 17 list it before `node`/`require`. Without it Vite would pick graphql's CJS build for inlined sources while Node-loaded externals (Apollo, graphql-scalars) get the ESM build. You then get two graphql realms: `Cannot use GraphQLSchema from another module or realm` |
| Vite defaults minus `module` and `development\|production` | `module` is bundler-only. Node never sets `development\|production`                                                                                                                                                                                                                                                                          |

So: **do not** add `vi.mock('graphql')` or alias workarounds for "another realm" errors. If one
appears, a resolve condition is out of sync with Node.

## Integration tests (testcontainers)

`*.int-spec.ts` files run against real infrastructure. Their `<name>:int` projects only exist when
`INTEGRATION=1`, so a plain `bun run test` never runs them, even by accident.

| Spec                                                                                                                                                        | Project        | Needs                                                                                                 | Covers                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| [`libs/database/test/database.int-spec.ts`](../libs/database/test/database.int-spec.ts)                                                                     | `database:int` | Docker (testcontainers `postgres:18.6-alpine3.24`)                                                    | migrations, PG18-native `uuidv7()`, `@Transactional()`                                                                     |
| [`libs/identity/src/infrastructure/persistence/users.repository.int-spec.ts`](../libs/identity/src/infrastructure/persistence/users.repository.int-spec.ts) | `identity:int` | Docker (testcontainers), **or** `INTEGRATION_DATABASE_URL` pointing at an existing throwaway database | drizzle users/sessions repositories through the real `DatabaseModule`, which applies the real generated migrations at boot |
| [`libs/redis/src/redis.int-spec.ts`](../libs/redis/src/redis.int-spec.ts)                                                                                   | `redis:int`    | a running Redis at `REDIS_URL` (for example `bun run docker:infra`). Not testcontainers               | the throttle Lua script against its `InMemoryRedis` JS model, cache, Redlock, the socket.io Redis adapter                  |

```bash
bun run docker:infra                                   # Redis (and the rest of the infra) for redis:int
bun run test:int                                       # every *:int project
INTEGRATION=1 bunx vitest run --project database:int   # just one
```

The Redis spec puts every key under a random `it-<id>` prefix and deletes them afterwards. The
identity spec uses unique e-mails, so you can rerun it against the same database.

## Load testing (k6)

Load tests are not part of Vitest. [`docker/k6/script.js`](../docker/k6/script.js) is a k6 open-model
(constant-arrival-rate) test of the edge API on `http://api:3000`, which is the monolith or the gateway:

- `journey` scenario (always on): register, login, `GET /v1/auth/me`, `GET /v1/users/:id`,
  `POST /graphql { me }` for a new user, `RATE` times per second.
- `browse` scenario (`READ_RATE` > 0): authenticated reads only.

```bash
bun run docker:monolith            # or: bun run docker:microservices
bun run docker:observability       # optional: results land in Prometheus/Grafana (host port 3300)
bun run loadtest                   # = docker compose --profile loadtest run --rm k6
K6_RATE=20 K6_DURATION=2m bun run loadtest
```

Thresholds are `K6_P95_MS` (default 250) and `K6_MAX_ERROR_RATE` (default 0.01). The HTML report is
written to `docker/k6/reports/k6-report.html`, and the live dashboard is on `127.0.0.1:5665`. Without
the observability profile, set `K6_OUT=` (empty). See [PERFORMANCE.md](PERFORMANCE.md) for results and
tuning, for example why `UV_THREADPOOL_SIZE` must stay at or below the container CPU quota, and
[DOCKER.md](DOCKER.md) for the compose profiles.

## Known gaps

- **Billing and notifications repositories have no real-database integration specs yet.** Their
  persistence is covered by unit specs and by app e2e suites over fake Postgres and Cassandra clients.
  Adding `*.int-spec.ts` files modelled on `identity:int` (and a Cassandra testcontainer) is a planned
  follow-up.
- Kafka and gRPC have no broker or cross-process integration specs. The e2e suites run gRPC for real
  on loopback, and replace Kafka with `FakeKafkaProducer` and `InMemoryKafkaServer`. Events are
  published after commit today; there is no transactional outbox yet. Tests assert on what was
  published, not on delivery guarantees.

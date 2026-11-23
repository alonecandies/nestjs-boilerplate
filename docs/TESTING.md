# Testing

How the test suite is organised, how to run it and how to write new tests.

All tests run on **Vitest 5** from one root [`vitest.config.ts`](../vitest.config.ts). Workspace libraries
resolve to their TypeScript sources, so nothing has to be built before testing. The default suite
(`bun run test`) needs **no Docker and no running infrastructure**.

See also: [README.md](../README.md) · [DEVELOPMENT.md](DEVELOPMENT.md) · [ARCHITECTURE.md](ARCHITECTURE.md) ·
[PERFORMANCE.md](PERFORMANCE.md) · [DOCKER.md](DOCKER.md) · [`@platform/testing`](../libs/testing/README.md)

## Test pyramid

```mermaid
flowchart TB
  int["*.int-spec.ts<br/>real Postgres 18 + Citus / Redis<br/>opt-in: INTEGRATION=1"]
  e2e["apps/*/test/*.e2e-spec.ts<br/>real AppModule, fakes at network edges<br/>no Docker"]
  unit["src/**/*.spec.ts, test/**/*.spec.ts<br/>handlers, domain, pipes, guards, adapters"]
  int --> e2e --> unit
```

| Layer       | Files                                                    | What is real                                                                                                                                        | What is fake                                                                                    | Runs by default          |
| ----------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------ |
| Unit        | `src/**/*.spec.ts`, `test/**/*.spec.ts` in every package | the class under test                                                                                                                                | collaborators, usually `createMock<T>()`                                                        | yes                      |
| App e2e     | `apps/<app>/test/*.e2e-spec.ts`                          | the app's `AppModule`, global pipes/guards/filters, HTTP wiring (Fastify via `app.inject()`), and for the services a gRPC server on a loopback port | only network edges: Postgres client, Redis, Kafka, Cassandra, object storage, upstream services | yes                      |
| Integration | `*.int-spec.ts`                                          | Postgres 18 + Citus 14.2 (testcontainers, single node) or Redis                                                                                     | nothing                                                                                         | no, `INTEGRATION=1` only |

Every app has an e2e spec: `monolith`, `gateway`, `identity-service`, `notifications-service`,
`billing-service`. Every app also has `test/env-example.spec.ts`, which checks that the app's
`.env.example` passes every config namespace the app loads and pins its ports (the services do not
reuse each other's ports). The rate-limit proof lives in `apps/{monolith,gateway}/test/rate-limit.e2e-spec.ts`
(real `AppModule`, in-memory Redis with the throttle script emulated), next to the guard-order smoke spec
`libs/bootstrap/src/rate-limit-order.spec.ts`. Wave 2 adds the shared tenant budget (two members of one tenant
exhaust it, another tenant is unaffected; gateway spec) and the GraphQL cost budget (HTTP 429 per user, one token
verification per operation; `apps/monolith/test/graphql-cost-limit.e2e-spec.ts`).

The rule for e2e tests: **fake only at the network edge**. Swap the client or port that would open a
socket, and keep repositories, CQRS handlers, enhancers and serialization real. For example,
identity-service runs a real drizzle instance over a fake postgres.js client rather than mocking its
repositories.

## Vitest projects

[`vitest.config.ts`](../vitest.config.ts) builds the project list itself. Every folder under `apps/`,
`domains/` or `libs/` that has a `package.json` becomes a project, and so does a domain's nested contracts
package (`<domain>-contracts`):

| Project name | Created for                                | Includes                                        | Timeouts (test / hook) |
| ------------ | ------------------------------------------ | ----------------------------------------------- | ---------------------- |
| `<name>`     | every package (unit)                       | `src/**/*.spec.ts`, `test/**/*.spec.ts`         | 15 s / 30 s            |
| `<app>:e2e`  | every app                                  | `test/**/*.e2e-spec.ts`                         | 30 s / 60 s            |
| `<name>:int` | every package, **only if `INTEGRATION=1`** | `src/**/*.int-spec.ts`, `test/**/*.int-spec.ts` | 120 s / 180 s          |

Examples: `redis`, `identity`, `billing-contracts`, `gateway`, `gateway:e2e`, `identity-service:e2e`,
`database:int`, `identity:int`. A new package gets its projects automatically. You do not need to register it.
Project names must be unique, so a lib that shares a domain's folder name is `platform-<name>` (`libs/ai` is
`platform-ai`, `domains/ai` is `ai`).
One more project, `scripts`, runs the specs of the repo tooling (`scripts/**/*.spec.ts`, such as the layer boundary
check) and the docs checks: `scripts/docs-catalogue.spec.ts` (error codes in API.md) and `scripts/docs-b3.spec.ts`
(SECURITY.md lists exactly the system methods, elevation reasons and boot guard checks of the code, CONFIGURATION.md the
database keys, and the spec delta and READMEs describe B3).
The packaging scripts have fixture-tree specs there too: `scripts/check-api-subpaths.spec.ts` builds small workspace
trees to pin the `./api` graph rule (a domain's `./api` reaches no core, persistence or messaging module; the gateway
imports a domain only through `@domain/<x>/api`; `--require-all`), and `scripts/docker/assemble-image.spec.ts` builds
fixture install trees to pin the image file tracing (traced files kept, the rest deleted, `--trace false`, `--keep`, the
load check).

Shared settings: `globals: true`, `setupFiles: ['reflect-metadata']`, `pool: 'forks'` (Nest apps hold
sockets and timers, and forks isolate them most reliably), `clearMocks` and `restoreMocks`. Coverage
uses the `v8` provider over `apps/*/src/**`, `domains/*/src/**`, `domains/*/contracts/src/**` and
`libs/*/src/**`. It skips generated code, specs, `index.ts` and `main.ts`, and writes the
`text-summary`, `html` and `lcov` reporters to `coverage/`.

## Commands

| Command                                                | Runs                                                                                                           |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `bun run test`                                         | `vitest run`: every unit **and** e2e project (integration projects do not exist without `INTEGRATION=1`)       |
| `bun run test:watch`                                   | `vitest` in watch mode                                                                                         |
| `bun run test:e2e`                                     | `vitest run --project '*:e2e'`: the five app e2e suites only                                                   |
| `bun run test:cov`                                     | `vitest run --coverage`: unit + e2e with v8 coverage                                                           |
| `bun run test:int`                                     | `INTEGRATION=1 vitest run --project '*:int'`: integration specs (needs Docker and Redis, see below)            |
| `bunx vitest run --project redis`                      | one project                                                                                                    |
| `bunx vitest run --project 'identity*'`                | glob over project names (here `identity`, `identity-contracts`, `identity-service` and `identity-service:e2e`) |
| `bunx vitest run libs/auth/src/guards`                 | a path filter, within all matching projects                                                                    |
| `INTEGRATION=1 bunx vitest run --project identity:int` | one integration project                                                                                        |
| `bun run --filter @app/gateway test` / `test:e2e`      | the package's own script (`vitest run --config ../../vitest.config.ts --project gateway[:e2e]`)                |

`bun run check` is the static gate (Biome, ESLint, Prettier, `tsc`, the layer boundary check). It does
**not** run tests, so run `bun run test` too before pushing. CI
([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)) runs `bun run test` in the quality job and
`bun run test:int` in a separate `integration` job. That job has Docker for testcontainers and a `redis`
service container with `REDIS_URL=redis://localhost:6379`.

## Writing tests

### Toolbox

| Helper                                                                                                             | Import from                                                     | Use it for                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createFastifyTestApp(builder, configure?, options?)`                                                              | `@platform/testing`                                             | Compiles a `TestingModuleBuilder` into a **ready** Fastify app with URI versioning (default `v1`). It binds no port, so drive it with `app.inject()`                                                                                                                                                                              |
| `createMock<T>(overrides?)` / `Mocked<T>`                                                                          | `@platform/testing`                                             | Proxy auto-mock. Every member you touch is a cached `vi.fn()`. Also works with `builder.useMocker(() => createMock())`                                                                                                                                                                                                            |
| `startTestPostgres(options?)`                                                                                      | `@platform/testing/postgres`                                    | A fresh single-node Citus 14.2 container per int spec (`url`, `urlFor(role, password)`, `stop()`); `localExecution: false` forces remote shard execution; `initSql` runs as superuser; `INTEGRATION_DATABASE_URL` only with `allowExternalUrl: true`                                                                              |
| `startRlsTestPostgres(options?)`, `TEST_DB_ROLES`, `readRolesInitSql()`                                            | `@platform/testing/postgres`                                    | Every spec that asserts isolation: a fresh container (never `INTEGRATION_DATABASE_URL`), local execution off by default, the roles of `docker/postgres/init/02-roles.sql` and `03-pgbouncer-auth.sql`; `migrationUrl` (`app_owner`), `runtimeUrl` (`app_runtime`), `systemUrl` (`app_system`), and `url` (superuser, for seeding) |
| `InMemoryRedis` (`.asRedis()`)                                                                                     | `@platform/redis/testing`                                       | ioredis stand-in: strings with PX/EX, counters, pub/sub across `duplicate()`, and the package's Lua throttle script emulated in JS                                                                                                                                                                                                |
| `FakeKafkaProducer`                                                                                                | `@platform/transport/testing`                                   | Validates envelopes like the real `KafkaProducer`, then records them. Read them with `published(contract)`, `envelopes(contract)` (e.g. `published(USER_REGISTERED_EVENT)`) or `records`; `failNextWith(err)` makes the next publish fail                                                                                         |
| `InMemoryStorageService`                                                                                           | `@platform/storage/testing`                                     | `StorageService` held in memory, with the real driver contract and fake `memory://` presigned URLs                                                                                                                                                                                                                                |
| `makeAuthUser(overrides?)`                                                                                         | `@platform/auth/testing`                                        | A valid `AuthUser` (a regular user by default). Overriding `roles` without `permissions` resolves the permissions from the roles, as production does                                                                                                                                                                              |
| `signTestAccessToken(claims, { config? })`                                                                         | `@platform/auth/testing`                                        | Signs access tokens for specs and e2e harnesses with the configured secret, so tests no longer need identity's token issuance. `config` defaults to the `auth` namespace of `process.env`                                                                                                                                         |
| `createFakePostgres(schema, handler)`                                                                              | `apps/{identity,billing}-service/test/support/fake-postgres.ts` | A **real** drizzle instance over a fake postgres.js client. `handler(sql, params)` returns rows **in SELECT column order**; `executed` logs every query                                                                                                                                                                           |
| `createFakePostgres`, `createFakeCassandra`, `createFakeQueue`                                                     | `apps/monolith/test/support/fake-infrastructure.ts`             | The monolith's edge fakes                                                                                                                                                                                                                                                                                                         |
| `createInMemoryIdentityPersistence`, `InMemoryIdentityStore`                                                       | `@domain/identity/testing`                                      | In-memory users and sessions repositories and an inline `TransactionRunner` (monolith e2e)                                                                                                                                                                                                                                        |
| `createFakeCassandra(handler)`, `InMemoryKafkaServer`                                                              | `apps/notifications-service/test/support/`                      | Fake CQL client, and a Kafka transport strategy that delivers in-process                                                                                                                                                                                                                                                          |
| `FakeIdentityState`, `FakeAuthPort`, `FakeUsersPort`                                                               | `@domain/identity/testing`                                      | A fake identity-service behind the gateway's `AuthPort`/`UsersPort`                                                                                                                                                                                                                                                               |
| `FakeTenancyState`, `FakeTenantsPort`, `FakeMembersPort`, `FakeInvitationsPort`                                    | `@domain/identity/testing`                                      | The tenants, members and invitations behind the gateway's ports: one shared state, roles and last-owner rules, invitation tokens. They do not cross-check the principal (`requireTenantActor`) or the staff rule: assert those in monolith specs                                                                                  |
| `FakeNotificationsPort`                                                                                            | `@domain/notifications/testing`                                 | A fake notifications-service inbox behind the gateway's `NotificationsPort`                                                                                                                                                                                                                                                       |
| `graphql(query, variables?, headers?)`, `bearer(token)`, `expectProblem(res, status, code?)`, `multipartFile(...)` | `apps/{gateway,monolith}/test/support/http.ts`                  | `inject()` options for `POST /graphql`, an `Authorization` header, an RFC 9457 problem assertion (it also checks that `requestId` matches the header), and a multipart upload body                                                                                                                                                |
| `startServiceTestApp(builder, { grpc, kafka? })`, `freePort()`                                                     | `apps/<service>/test/support/`                                  | Boots a service like `main.ts` does (HTTP wiring, gRPC server on a real loopback port, optional in-process Kafka consumer)                                                                                                                                                                                                        |
| `createFakeSql`                                                                                                    | `libs/database/test/fake-sql.ts`                                | postgres.js `Sql` stand-in for module wiring, `@Transactional()`, health and migration-lock unit tests                                                                                                                                                                                                                            |
| `createFakeCassandraClient`                                                                                        | `libs/cassandra/test/fake-cassandra.ts`                         | cassandra-driver stand-in for the Cassandra lib's unit tests                                                                                                                                                                                                                                                                      |
| `InMemoryPaymentsRepository`, `InMemoryStripeEventsRepository`                                                     | `domains/billing/test/billing-test.utils.ts`                    | Billing repositories in memory                                                                                                                                                                                                                                                                                                    |
| `startBillingDatabase(providers, { runMigrations?, localExecution? })`                                             | `domains/billing/test/billing-database.ts`                      | A fresh Citus database with the platform set and billing's migrations applied by the real `DatabaseModule`, plus your providers. Int specs only; tenant-isolation specs pass `localExecution: false`                                                                                                                              |

`@platform/testing` depends on no other workspace package and imports `vitest`. Import it only from spec
files and `test/**`. `@platform/redis/testing` is a separate subpath for the same reason: production code
never loads it. `scripts/check-boundaries.mjs` (in `bun run check`) fails on a production import of
either.

### A unit test

```ts
// domains/identity/src/application/queries/get-user-by-id/get-user-by-id.handler.spec.ts
import { EntityNotFoundException, generateId } from '@platform/common';
import { createMock } from '@platform/testing';
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
import { IDENTITY_GRPC_PACKAGE } from '@domain/identity-contracts';

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
  app = await startServiceTestApp(builder, { grpc: [IDENTITY_GRPC_PACKAGE] });
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

`tenancy-journeys.e2e-spec.ts` exists in both `apps/monolith/test` and `apps/gateway/test` and walks the same
tenants, members and invitations journeys in each topology. The gateway's identity fakes (`FakeTenancyState` and the
`Fake*Port`s) do not cross-check the principal or the staff switch-in rule, so those rules are asserted only in the
monolith journeys, where the real handlers run.

### Tenant isolation suites

`tenant-isolation.e2e-spec.ts` exists in both `apps/monolith/test` and `apps/gateway/test` and runs the same four cases
in each topology (B4-7). Fixtures go through the real flows (register, invite, accept, login, switch-tenant), never
hand-signed tokens: U owns tenant A and is an admin of tenant B, W owns B, V is an admin of A only, so U is the user
who is a member of both.

1. **Notifications.** n1 for (A, U), n2 for (B, U), n3 for (A, V). U with A's token lists exactly `[n1]` over REST and
   GraphQL; marking n2 read is 404 and n2 stays unread; after `switch-tenant` to B the list is exactly `[n2]` and the
   old token is 401 `TOKEN_REVOKED`.
2. **Files.** U's upload in A is keyed `tenants/<A>/users/<U>/…`. With B's token U (and W, an owner) get 403 on
   download-url and delete and the object stays; V (`files:manage` in A) gets a download URL; a legacy `users/<U>/x` key
   put straight into storage is 403 for U and V.
3. **Payments.** U has p1 in A and p2 in B. A's token lists p1 only, `all=true` as V lists A's payments only, B's token
   never lists p1. Monolith: the fake Postgres answers by the tenant parameter and the spec asserts every executed
   payments statement bound the token's tenant. Gateway: a `BillingPort` stand-in that answers by the request's tenant.
4. **User cache.** V reads U in A twice and its own profile (cached); W, acting in B, then reads V and gets 404; U,
   acting in B, reads W and gets 200.

Each store is proved where it can be: Postgres payments by B3's real-Citus journeys (the edge wiring here), the Cassandra
inbox by the int specs of the notifications domain (real handlers over the in-memory repositories here in the monolith,
the tenant-keyed `FakeNotificationsPort` in the gateway), storage through the real `FilesService` over
`InMemoryStorageService`, and the cache through the real `AppCacheService` L1 tier. The monolith harness binds the
in-memory notifications repositories by default (`notificationStores: 'cassandra'` keeps the real adapters over the fake
Cassandra client, which answers every query with no rows). The digest cron's system context is a unit spec
(`daily-digest.cron.spec.ts`).

### Outbox and ledger suites

The Postgres domains publish through the transactional outbox, so an e2e that expects an event on Kafka ticks the relay
first. The monolith harness binds `InMemoryOutbox` (`@platform/outbox/testing`) as `IdentityOutbox` and `BillingOutbox`
and as their system repositories, never starts the app's own relays (`OUTBOX_RELAY_ENABLED=false`) and returns
`tickRelays()` (one poll → publish → mark cycle per outbox, to the `FakeKafkaProducer`) and `flushOutboxes()`.
`outbox.e2e-spec.ts` pins the contract: a request leaves rows and publishes nothing, a tick delivers them once, a failing
producer leaves the rows for a later tick, and the records, replayed through `consumers.deliver()`, reach the real
notifications handlers.

`ledger.e2e-spec.ts` (outbox plan Task 19) runs the whole ledger path in the monolith, in memory:
`createMonolithE2eApp({ ledger: true })` with `LEDGER_ENABLED=true` binds `InMemoryLedger` as `LedgerPort`, one
`InMemoryLedgerStore` (receipts and system repository over billing's in-memory outbox) and `FakeStripe` (the real SDK
with the ledger's GETs answered from a list, so signature verification is real). The cases: a signed `charge.succeeded` →
one outbox row and nothing on Kafka → a tick → the app's own `LedgerPostingConsumer` posts one balanced entry and one
ref; the same webhook again and the same Kafka message again add nothing; `payout.paid` → a platform entry in
`SystemContext`; a `ReconcileLedgerCommand` run `succeeded` with no findings; after `InMemoryLedger#tamper` the next run
reports `ledger_row_mutated` once. The microservices topology is covered by `billing-service`'s e2e (the webhook RPC
leaves its posting record in the unit of work of its receipt with `LEDGER_ENABLED=true`, none with `false`) and the
gateway's (the edge forwards the raw bytes and answers as billing-service does; it owns neither an outbox nor a ledger).

`scripts/prometheus-rules.spec.ts` parses `docker/prometheus/rules/*.rules.yml`: exactly the planned alerts with their
severities, thresholds, and only series the code registers in every `expr`. It also fails when a doc still describes the outbox as missing or events as published after commit, except in the notifications note.

### Real Socket.IO suites

`realtime-socket.e2e-spec.ts` (E-1) is the first spec that reaches the `/notifications` gateway over a real
connection: `socket.io-client` (websocket transport, no reconnection) against an app bound to `127.0.0.1` on a free
port by `listenOnLoopback` (`@platform/testing/realtime`, which also holds the client helpers `SocketClients`,
`connected`, `refused`, `nextEvent`, `disconnected`, `collectEvents`). It binds a port, so it needs the sandbox off,
like every spec that listens. Both files set `WS_REVOCATION_SWEEP_INTERVAL_MS=200` before the app boots and raise
C11's connection caps so they never interfere. No Kafka and no Redis adapter are connected (one process): a push is
driven by calling `app.get(NotificationPushConsumer).onNotificationCreated(envelope)` with an envelope from
`createEventEnvelope`, which is what the Kafka server does.

- **Monolith (full suite, the notifications core is real).** Handshake (`MISSING_TOKEN`, `TOKEN_EXPIRED`,
  `TOKEN_REVOKED`, `INVALID_TOKEN`; `auth.token` and the `Authorization` header connect, a query-string token does not),
  messages (`ping`/`pong`, `notifications.markRead` acks `{ ok: true }`, 404 and 400, the 429 of the
  `notifications.mark-read` policy, an `exception` event when no ack callback is given), push and rooms (an envelope for
  (A, U) reaches U's socket in A exactly once in the REST shape, not U's socket in B nor V's in A; a redelivered
  envelope id and an envelope without `tenantId` push nothing), expiry (`exception` `TOKEN_EXPIRED`, then
  `io server disconnect`), revocation (a logged-out token's socket closes within two sweep intervals; a message sent
  before the sweep is refused with 401 `TOKEN_REVOKED`) and a real tenant switch (the switched-away socket closes, the
  user's other session keeps its socket, the new token's socket gets (B, U) pushes only).
- **Gateway (reduced suite, the cases that need no real inbox).** Handshake, push and rooms, revocation (including the 401
  for a message sent between logout and sweep, which the session guard answers before the inbox) and the tenant
  switch, against the Socket.IO host of the microservices topology. The other per-message cases (acks, the
  mark-read policy) use the fake notifications-service there, so they stay in the monolith suite.

Fixtures go through register, invite, accept, login and switch-tenant. The one hand-signed token is the short-lived
and the already expired one (`TokenIssuer.issueAccessToken` with a `ttlSec`), because the real flows cannot mint
them. Not covered: fan-out across replicas through the Redis adapter, and C11's socket caps (C12 owns C's e2e).

### Real graphql-ws suites

`realtime-graphql.e2e-spec.ts` (E-2) does the same for the GraphQL subscription transport: `createClient` from
`graphql-ws` on Node 24's global `WebSocket` (`GraphqlWsClients` in `@platform/testing/realtime`: the close event
`{ code, reason }`, a `next` collector and a one-shot `execute`) against the same loopback app. It runs on both
harnesses (the monolith with the real notifications core, the gateway with the fake notifications-service), with
`WS_REVOCATION_SWEEP_INTERVAL_MS=200` and `GRAPHQL_MAX_COMPLEXITY=20` set before the app boots. Pushes are driven as in
the Socket.IO suites; a delivery test first waits until the server's iterator listens on the `(tenant, user)` trigger
(the in-process `PubSub` loses a message published earlier), so it never races the subscription.

- **Connection.** No token, an invalid, an expired and a denylisted token close 4403; `{ authorization: 'Bearer …' }`
  and `{ token }` are both acknowledged.
- **Delivery and filters.** An (A, U) envelope gives exactly one `next`; (B, U) and (A, V) envelopes give none; a (B, U)
  payload published straight onto the (A, U) trigger gives none; a query sent over the socket reads tenant A's inbox only.
- **Expiry and sweep.** A 2 s token closes 4401 `Access token expired`; a logout closes 4401 `Access token revoked`
  within two sweep intervals; a tenant switch closes the old token's socket the same way while the user's second
  session (another jti) stays open, and a socket on the new token gets (B, U) pushes only.
- **Complexity.** An operation above `GRAPHQL_MAX_COMPLEXITY` sent on the socket returns `QUERY_TOO_COMPLEX` and the
  socket serves the next operation.

Not covered: the 10 s `connection_init` timeout (4408) and C11's connection caps (C12 owns C's e2e).

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
| `@repo/source`                                             | Workspace packages export `"@repo/source": "./src/*.ts"` next to `"default": "./dist/*.js"`. Tests (like `tsc` and `bun run dev`) load TS sources, so **no lib build is needed** before testing                                                                                                                                              |
| `module-sync`                                              | Node ≥ 22.10 honours it natively, and dual packages such as graphql 17 list it before `node`/`require`. Without it Vite would pick graphql's CJS build for inlined sources while Node-loaded externals (Apollo, graphql-scalars) get the ESM build. You then get two graphql realms: `Cannot use GraphQLSchema from another module or realm` |
| Vite defaults minus `module` and `development\|production` | `module` is bundler-only. Node never sets `development\|production`                                                                                                                                                                                                                                                                          |

So: **do not** add `vi.mock('graphql')` or alias workarounds for "another realm" errors. If one
appears, a resolve condition is out of sync with Node.

## Test output and timeouts

`vitest.setup.ts` is loaded by every project after `reflect-metadata`. It drops Nest's static logger
and mutes the errors of the `TestingLogger` that `Test.createTestingModule().compile()` installs, so
specs that exercise failure paths print no `[Nest]` lines or stack traces. To see them while
debugging, set `TEST_LOGS=1` (for example `TEST_LOGS=1 npx vitest run --project billing`). Specs
that assert on logging spy on `Logger.prototype` methods, which still run, or pass their own logger
with `Test.createTestingModule(…).setLogger(…)`.

Unit and `scripts` projects allow 15 s per test and 30 s per hook (`UNIT_TEST_TIMEOUT_MS`,
`UNIT_HOOK_TIMEOUT_MS` in `vitest.config.ts`), because they compile Nest modules and run gRPC round
trips in-process. e2e projects keep 30 s / 60 s and integration projects 120 s / 180 s.

## Integration tests (testcontainers)

`*.int-spec.ts` files run against real infrastructure. Their `<name>:int` projects only exist when
`INTEGRATION=1`, so a plain `bun run test` never runs them, even by accident.

| Spec                                                                                                                                                                      | Project             | Needs                                                                                                                                                                                                                                                                                                                                                            | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`libs/database/test/database.int-spec.ts`](../libs/database/test/database.int-spec.ts)                                                                                   | `database:int`      | Docker (`@platform/testing/postgres`: `citusdata/citus:14.2.0`)                                                                                                                                                                                                                                                                                                  | migration sets (one lock, one bookkeeping table per set), the CLI, PG18-native `uuidv7()`, `@Transactional()`                                                                                                                                                                                                                                                                                                                                                                    |
| [`libs/database/test/citus.int-spec.ts`](../libs/database/test/citus.int-spec.ts)                                                                                         | `database:int`      | Docker (`@platform/testing/postgres`)                                                                                                                                                                                                                                                                                                                            | the platform set's Citus helpers on Citus and on a plain database, and the runner's Citus session settings (a set that creates an enum, distributes tables and adds their foreign keys in one transaction)                                                                                                                                                                                                                                                                       |
| [`libs/database/test/pool-usage.int-spec.ts`](../libs/database/test/pool-usage.int-spec.ts)                                                                               | `database:int`      | Docker (`@platform/testing/postgres`)                                                                                                                                                                                                                                                                                                                            | `PoolUsage` (the `db_pool_*` gauges) on a real postgres.js pool: connections in use up to the pool max and the rest waiting, a transaction counted once, a failed query released                                                                                                                                                                                                                                                                                                 |
| [`libs/testing/src/postgres/start-test-postgres.int-spec.ts`](../libs/testing/src/postgres/start-test-postgres.int-spec.ts)                                               | `testing:int`       | Docker (`@platform/testing/postgres`)                                                                                                                                                                                                                                                                                                                            | the Citus test container: version, shard count, local vs remote execution (`localExecution`), `initSql`, `urlFor` logins with URL-reserved characters                                                                                                                                                                                                                                                                                                                            |
| [`libs/testing/src/postgres/roles.int-spec.ts`](../libs/testing/src/postgres/roles.int-spec.ts)                                                                           | `testing:int`       | Docker (`@platform/testing/postgres`)                                                                                                                                                                                                                                                                                                                            | the three database roles from `docker/postgres/init`: attributes, role settings, `search_path`, who may create schemas and distribute tables, `pgbouncer.get_auth`, the script run twice, `INTEGRATION_DATABASE_URL` ignored by default                                                                                                                                                                                                                                          |
| [`domains/identity/src/infrastructure/persistence/users.repository.int-spec.ts`](../domains/identity/src/infrastructure/persistence/users.repository.int-spec.ts)         | `identity:int`      | Docker (`@platform/testing/postgres`: Citus)                                                                                                                                                                                                                                                                                                                     | drizzle users/sessions repositories through the real `DatabaseModule`, which applies the platform set and identity's own history at boot: tables, enum and indexes in schema `identity`, nothing in `public`, bookkeeping counts match the journals, a second boot is a no-op                                                                                                                                                                                                    |
| [`domains/identity/src/infrastructure/persistence/tenancy.repositories.int-spec.ts`](../domains/identity/src/infrastructure/persistence/tenancy.repositories.int-spec.ts) | `identity:int`      | Docker (`@platform/testing/postgres`, `localExecution: false`): tenants, memberships, the members and last-owner concurrency block, invitations and their accept                                                                                                                                                                                                 |
| [`domains/billing/src/infrastructure/persistence/billing.migrations.int-spec.ts`](../domains/billing/src/infrastructure/persistence/billing.migrations.int-spec.ts)       | `billing:int`       | Docker (`@platform/testing/postgres`: Citus)                                                                                                                                                                                                                                                                                                                     | billing's generated history after the platform set: tables, enum and indexes in schema `billing`, nothing in `public`, bookkeeping counts match the journals, DB defaults, a second boot is a no-op                                                                                                                                                                                                                                                                              |
| [`domains/billing/src/infrastructure/persistence/billing.repositories.int-spec.ts`](../domains/billing/src/infrastructure/persistence/billing.repositories.int-spec.ts)   | `billing:int`       | Docker (`@platform/testing/postgres`, `localExecution: false`): tenant scoping of payments, an `Idempotency-Key` per tenant and user, stripe events per tenant, and the `0001` backfill                                                                                                                                                                          |
| [`apps/monolith/test/rls-journeys.int-spec.ts`](../apps/monolith/test/rls-journeys.int-spec.ts)                                                                           | `monolith:int`      | Docker (`@platform/testing/postgres`, `startRlsTestPostgres()`, local execution off). The harness is `apps/monolith/test/support/rls-app.ts`: the real `AppModule` (identity and billing together) migrated as `app_owner`, running as `app_runtime`, system pool as `app_system`, boot guard `enforce`; only Redis, Cassandra, mail, Kafka and Stripe are fakes | the journeys of spec section 13 under RLS, once with `DATABASE_PREPARE=true` and once `false`, on a four-connection pool: separate tenants, exact rows per table (handlers and bare `app_runtime` SQL), invite, accept and switch, payments across a tenant switch, staff switch-in with its audit row, 200 interleaved requests of four principals, `409 EMAIL_TAKEN` from the real unique violation, and an `UPDATE` that tries to move a row to another tenant in each domain |
| [`domains/notifications/test/recipients.int-spec.ts`](../domains/notifications/test/recipients.int-spec.ts)                                                               | `notifications:int` | Docker (`@platform/testing/cassandra`: `cassandra:5.0.9`): the real CQL migrations and the recipients repository                                                                                                                                                                                                                                                 |
| [`domains/notifications/test/inbox-isolation.int-spec.ts`](../domains/notifications/test/inbox-isolation.int-spec.ts)                                                     | `notifications:int` | Docker (`@platform/testing/cassandra`): the per-`(tenant, user)` inbox, paging states and `markRead`                                                                                                                                                                                                                                                             |
| [`libs/storage/test/storage-drivers.int-spec.ts`](../libs/storage/test/storage-drivers.int-spec.ts)                                                                       | `storage:int`       | Docker (testcontainers `rustfs/rustfs:1.0.0`, `fsouza/fake-gcs-server:1.56.1`)                                                                                                                                                                                                                                                                                   | both drivers against their emulators: buffer and multipart stream upload, HEAD, idempotent DELETE, presigned PUT/GET signed for a public host that differs from the API's endpoint (keys with spaces and non-ASCII), S3 content-length pinning and download filename                                                                                                                                                                                                             |
| [`libs/redis/src/redis.int-spec.ts`](../libs/redis/src/redis.int-spec.ts)                                                                                                 | `redis:int`         | a running Redis at `REDIS_URL` (for example `bun run docker:infra`). Not testcontainers                                                                                                                                                                                                                                                                          | the throttle Lua script against its `InMemoryRedis` JS model, cache, Redlock, the socket.io Redis adapter                                                                                                                                                                                                                                                                                                                                                                        |
| [`libs/auth/src/ws/revocation-sweeper.int-spec.ts`](../libs/auth/src/ws/revocation-sweeper.int-spec.ts)                                                                   | `auth:int`          | a running Redis at `INTEGRATION_REDIS_URL` or `REDIS_URL`. Not testcontainers                                                                                                                                                                                                                                                                                    | the revocation channel across two replicas, each with its own main and subscriber connection: a `deny()` on one closes the session on the other before any sweep, a key written without a publish (an older replica) is closed by the next sweep, and malformed messages are ignored                                                                                                                                                                                             |

```bash
bun run docker:infra                                   # Redis (and the rest of the infra) for redis:int
bun run test:int                                       # every *:int project
INTEGRATION=1 bunx vitest run --project database:int   # just one
INTEGRATION=1 bunx vitest run --project storage:int    # S3 + GCS emulators
INTEGRATION=1 bunx vitest run --project monolith:int   # cross-domain RLS journeys (Citus, three roles)
INTEGRATION=1 bunx vitest run --project notifications:int   # Cassandra inbox and recipients
```

Postgres in every int spec is **Citus 14.2 on PostgreSQL 18.4, single node** (`citusdata/citus:14.2.0`, the
image compose runs). The image is amd64-only: on Apple Silicon, Docker Desktop runs it under emulation
(Rosetta), and a container starts in about 15 s. Pull it once before the first run
(`docker pull --platform linux/amd64 citusdata/citus:14.2.0`). On a loaded machine a container can miss the
120 s health wait ("Health check not healthy after 120000ms"): raise `TEST_POSTGRES_STARTUP_TIMEOUT_MS` (in ms;
the int projects' hook timeout follows it, plus 60 s), or run one `*:int` project at a time. `startTestPostgres({ localExecution: false })` makes even one node
send shard queries over connections, so a setting that would not reach a worker fails in the spec too.

Every spec gets its own container: `startTestPostgres()` ignores `INTEGRATION_DATABASE_URL` unless a spec
passes `allowExternalUrl: true`, and a spec that asserts isolation never does. Those specs start Postgres
with `startRlsTestPostgres()`, which runs the role script of `docker/postgres/init` (the same files compose
runs) and connects as `app_owner`, `app_runtime` or `app_system` (dev password = the role name).

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

- Kafka and gRPC have no broker or cross-process integration specs. The e2e suites run gRPC for real
  on loopback, and replace Kafka with `FakeKafkaProducer` and `InMemoryKafkaServer`. The outbox relay's
  poll, publish and mark cycle is driven by hand (`tickRelays()`), so the e2e suites prove what is written
  and relayed, not Kafka's own delivery guarantees.

# @platform/testing

Test-only helpers shared by every package's unit and e2e tests. It depends on **no other workspace
package** (so any package can use it without dependency cycles) and pulls in `vitest` (and, through the
`./postgres` and `./cassandra` subpaths only, testcontainers, postgres.js and cassandra-driver; through `./realtime` only, `socket.io-client` and `graphql-ws`) — import it only from `*.spec.ts`,
`*.int-spec.ts`, `*.e2e-spec.ts` and `test/**`.

## Public API

| Export                  | Signature                                                                                                                                                                 | Purpose                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `createFastifyTestApp`  | `(builder: TestingModuleBuilder, configure?: (app: NestFastifyApplication) => void \| Promise<void>, options?: FastifyTestAppOptions) => Promise<NestFastifyApplication>` | compile → `FastifyAdapter` → URI versioning (default `v1`) → `configure` → `init()` → Fastify `ready()` |
| `FastifyTestAppOptions` | `{ adapter?: FastifyAdapter; appOptions?: NestApplicationOptions }`                                                                                                       | custom adapter (body limit, multipart…) / `rawBody`, `logger`                                           |
| `createMock`            | `<T extends object>(overrides?: Partial<Record<keyof T, unknown>>) => Mocked<T>`                                                                                          | Proxy auto-mock: every accessed member is a cached `vi.fn()`                                            |
| `Mocked<T>`             | `{ [K in keyof T]: T[K] extends (...a: infer A) => infer R ? Mock<(...a: A) => R> : T[K] }`                                                                               | typed mock view                                                                                         |

### @platform/testing/postgres

| Export                 | Signature                                                                                                   | Purpose                                                                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `startTestPostgres`    | `(options?: TestPostgresOptions) => Promise<TestPostgres>`                                                  | a fresh single-node Citus container per int spec, or (with `allowExternalUrl: true`) the database at `INTEGRATION_DATABASE_URL`           |
| `TestPostgresOptions`  | `{ localExecution?: boolean; initSql?: readonly string[]; allowExternalUrl?: boolean }`                     | `localExecution: false` forces remote shard execution; `initSql` runs as superuser                                                        |
| `TestPostgres`         | `{ readonly url: string; urlFor(role, password): string; stop(): Promise<void> }`                           | superuser URL of database `app`; percent-encoded logins for other roles                                                                   |
| `TEST_POSTGRES_IMAGE`  | `'citusdata/citus:14.2.0'`                                                                                  | the image compose runs too                                                                                                                |
| `startRlsTestPostgres` | `(options?: { localExecution?: boolean }) => Promise<RlsTestPostgres>`                                      | the Postgres of every spec that asserts isolation: always a container, `localExecution` default `false`, `initSql` = `readRolesInitSql()` |
| `RlsTestPostgres`      | `TestPostgres & { readonly migrationUrl: string; readonly runtimeUrl: string; readonly systemUrl: string }` | logins as `app_owner`, `app_runtime`, `app_system` (dev password = role name); `url` stays the superuser, for seeding                     |
| `TEST_DB_ROLES`        | `{ owner: 'app_owner'; runtime: 'app_runtime'; system: 'app_system' }`                                      | the role names                                                                                                                            |
| `readRolesInitSql`     | `() => readonly string[]`                                                                                   | `docker/postgres/init/02-roles.sql` and `03-pgbouncer-auth.sql`, in that order (the files compose runs)                                   |

### @platform/testing/cassandra

| Export                       | Signature                                                                                                                  | Purpose                                                                                                |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `startTestCassandra`         | `(options?: { keyspace?: string }) => Promise<TestCassandra>`                                                              | a fresh single-node Cassandra container per int spec, with the keyspace created (SimpleStrategy, RF 1) |
| `TestCassandra`              | `{ readonly contactPoints: string[]; readonly localDataCenter: string; readonly keyspace: string; stop(): Promise<void> }` | `contactPoints` are `host:port` of the mapped CQL port; `stop()` is safe to call twice                 |
| `TEST_CASSANDRA_IMAGE`       | `'cassandra:5.0.9'`                                                                                                        | the image compose runs too (the int spec pins the two equal)                                           |
| `TEST_CASSANDRA_DATA_CENTER` | `'datacenter1'`                                                                                                            | the container's data center, a client's `localDataCenter`                                              |

```ts
import { startTestCassandra } from '@platform/testing/cassandra';

const node = await startTestCassandra(); // keyspace `test`
const client = new cassandra.Client({
  contactPoints: node.contactPoints,
  localDataCenter: node.localDataCenter,
  keyspace: node.keyspace,
});
// … run the context's CQL migrations (`CqlMigrator`), then the specs …
await client.shutdown();
await node.stop();
```

### @platform/testing/realtime

For specs that open real connections to an app listening on the loopback interface (import only from
`*.e2e-spec.ts`; it pulls in `socket.io-client` and `graphql-ws`).

| Export                                                            | Signature                                                                                      | Purpose                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `listenOnLoopback`                                                | `(app: NestFastifyApplication) => Promise<{ httpUrl: string; wsUrl: string }>`                 | binds an app from `createFastifyTestApp` to `127.0.0.1`, port 0; `app.close()` frees the port                                                                                                                                                                                          |
| `openSocket`                                                      | `(wsUrl: string, options: OpenSocketOptions) => Socket`                                        | a websocket-only, non-reconnecting `socket.io-client` (`namespace`, `token`, `headers`, `query`)                                                                                                                                                                                       |
| `connected`, `refused`                                            | `(socket, timeoutMs?) => Promise<Socket>`, `=> Promise<ConnectRefusal>`                        | wait for the connection, or for the `connect_error` of a refused handshake (`data` = problem details)                                                                                                                                                                                  |
| `nextEvent`, `collectEvents`, `disconnected`, `wait`, `waitUntil` | event helpers                                                                                  | the next payload of an event, a recorder, the disconnect reason, a pause, a polled condition                                                                                                                                                                                           |
| `SocketClients`                                                   | `new SocketClients(namespace)`: `track`, `open`, `connect`, `closeAll`                         | remembers every client of a spec so `afterAll` closes them all                                                                                                                                                                                                                         |
| `GraphqlWsClients`, `GraphqlWsConnection`                         | `new GraphqlWsClients()`: `open`, `connect(wsUrl, { connectionParams?, path? })`, `disposeAll` | a `graphql-ws` client on Node 24's global `WebSocket` (no retries): `closed` / `closedWithin()` give the close event `{ code, reason }`, `acknowledgement()` waits for `connection_ack`, `subscribe()` collects `next` data and errors, `execute()` runs one operation over the socket |

```ts
const app = await createFastifyTestApp(builder);
const { wsUrl } = await listenOnLoopback(app);
const clients = new SocketClients('/orders');
const socket = await clients.connect(wsUrl, { token: accessToken });
const pong = nextEvent<{ ts: string }>(socket, 'pong');
socket.emit('ping');
await pong;
clients.closeAll();
await app.close();
```

```ts
const gql = new GraphqlWsClients();
const connection = await gql.connect(wsUrl, {
  connectionParams: { authorization: `Bearer ${accessToken}` },
});
const feed = connection.subscribe({ query: 'subscription { orderPlaced { id } }' });
await waitUntil(() => feed.received.length > 0);
await gql.disposeAll(); // a refused token closes 4403: `(await gql.open(wsUrl, { connectionParams }).closedWithin()).code`
```

## Usage

```ts
import { createFastifyTestApp, createMock } from '@platform/testing';

const orders = createMock<OrdersPort>({
  getOrder: async (id: string) => ({ id, status: 'placed' }),
});

const app = await createFastifyTestApp(
  Test.createTestingModule({ imports: [OrdersApiModule.forLocal()] })
    .overrideProvider(OrdersPort)
    .useValue(orders),
  (app) => app.use(/* global middleware, ws adapter, … */),
);

const res = await app.inject({ method: 'GET', url: '/v1/orders/123' });
expect(orders.getOrder).toHaveBeenCalledWith('123');
await app.close();

// auto-mock every unresolved dependency
Test.createTestingModule({ providers: [SomeHandler] }).useMocker(() => createMock());
```

## Environment variables

`INTEGRATION_DATABASE_URL`: read by `startTestPostgres` only with `allowExternalUrl: true` (default `false`);
when set and not empty, that database is used instead of a container. `startRlsTestPostgres` never reads it.

`TEST_POSTGRES_STARTUP_TIMEOUT_MS`: how long `startTestPostgres` waits for a healthy container, in ms (default
120000, testcontainers' own). Raise it when the amd64-only Citus image starts slowly under emulation on a busy
machine. A value that is not a positive integer throws. The root `vitest.config.ts` keeps the int projects'
hook timeout 60 s above it.

## Gotchas

- `createMock` members are `vi.fn()`s: the root Vitest config sets `clearMocks: true`, so **call history is
  cleared before each test** — assert on calls made in the same test, not in `beforeAll`.
- Mocks report `then`, `toJSON`, `asymmetricMatch` and all symbols as `undefined`, so they can
  be awaited / returned from async factories / pretty-printed safely. `constructor` is a real, empty class
  (`MockedInstance`) and the prototype has no methods, so reflection-based explorers (the GraphQL resolver
  explorer, CQRS, schedule) find nothing to scan: a `createMock()` is safe as a provider in an app that boots
  `GraphQLModule`. Non-function members you read without
  overriding are also `vi.fn()`s at runtime — pass them in `overrides`.
- `createFastifyTestApp` doesn't bind a port: use `app.inject()` (or `supertest(app.getHttpServer())`).
- The Nest `Logger` is process-static: `appOptions.logger` of one test app affects others in the same worker.
- `startTestCassandra` waits for the node's "Starting listening for CQL clients" log line (up to 180 s): a
  cold Cassandra 5 node needs 30-90 s. The `cassandra:5.0.9` image is multi-arch, so it runs natively on
  Apple Silicon. Run Cassandra int projects one at a time: each starts its own 512 MB-heap node.
- `citusdata/citus:14.2.0` is amd64-only: Docker Desktop emulates it on Apple Silicon, so pull it once
  before the first int run (`docker pull --platform linux/amd64 citusdata/citus:14.2.0`).

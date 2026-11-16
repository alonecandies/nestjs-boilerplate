# @platform/testing

Test-only helpers shared by every package's unit and e2e tests. It depends on **no other workspace
package** (so any package can use it without dependency cycles) and pulls in `vitest` (and, through the
`./postgres` subpath only, testcontainers and postgres.js) — import it only from `*.spec.ts`,
`*.int-spec.ts`, `*.e2e-spec.ts` and `test/**`.

## Public API

| Export                  | Signature                                                                                                                                                                 | Purpose                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `createFastifyTestApp`  | `(builder: TestingModuleBuilder, configure?: (app: NestFastifyApplication) => void \| Promise<void>, options?: FastifyTestAppOptions) => Promise<NestFastifyApplication>` | compile → `FastifyAdapter` → URI versioning (default `v1`) → `configure` → `init()` → Fastify `ready()` |
| `FastifyTestAppOptions` | `{ adapter?: FastifyAdapter; appOptions?: NestApplicationOptions }`                                                                                                       | custom adapter (body limit, multipart…) / `rawBody`, `logger`                                           |
| `createMock`            | `<T extends object>(overrides?: Partial<Record<keyof T, unknown>>) => Mocked<T>`                                                                                          | Proxy auto-mock: every accessed member is a cached `vi.fn()`                                            |
| `Mocked<T>`             | `{ [K in keyof T]: T[K] extends (...a: infer A) => infer R ? Mock<(...a: A) => R> : T[K] }`                                                                               | typed mock view                                                                                         |

### @platform/testing/postgres

| Export                | Signature                                                                               | Purpose                                                                                         |
| --------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `startTestPostgres`   | `(options?: TestPostgresOptions) => Promise<TestPostgres>`                              | a fresh single-node Citus container per int spec, or the database at `INTEGRATION_DATABASE_URL` |
| `TestPostgresOptions` | `{ localExecution?: boolean; initSql?: readonly string[]; allowExternalUrl?: boolean }` | `localExecution: false` forces remote shard execution; `initSql` runs as superuser              |
| `TestPostgres`        | `{ readonly url: string; urlFor(role, password): string; stop(): Promise<void> }`       | superuser URL of database `app`; percent-encoded logins for other roles                         |
| `TEST_POSTGRES_IMAGE` | `'citusdata/citus:14.2.0'`                                                              | the image compose runs too                                                                      |

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

`INTEGRATION_DATABASE_URL`: read by `startTestPostgres` only (unless `allowExternalUrl: false`); when set and
not empty, that database is used instead of a container.

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
- `citusdata/citus:14.2.0` is amd64-only: Docker Desktop emulates it on Apple Silicon, so pull it once
  before the first int run (`docker pull --platform linux/amd64 citusdata/citus:14.2.0`).

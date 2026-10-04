# @app/testing

Test-only helpers shared by every package's unit and e2e tests. It depends on **no other workspace
package** (so any package can use it without dependency cycles) and pulls in `vitest` — import it only
from `*.spec.ts`, `*.e2e-spec.ts` and `test/**`.

## Public API

| Export                  | Signature                                                                                                                                                                 | Purpose                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `createFastifyTestApp`  | `(builder: TestingModuleBuilder, configure?: (app: NestFastifyApplication) => void \| Promise<void>, options?: FastifyTestAppOptions) => Promise<NestFastifyApplication>` | compile → `FastifyAdapter` → URI versioning (default `v1`) → `configure` → `init()` → Fastify `ready()` |
| `FastifyTestAppOptions` | `{ adapter?: FastifyAdapter; appOptions?: NestApplicationOptions }`                                                                                                       | custom adapter (body limit, multipart…) / `rawBody`, `logger`                                           |
| `createMock`            | `<T extends object>(overrides?: Partial<Record<keyof T, unknown>>) => Mocked<T>`                                                                                          | Proxy auto-mock: every accessed member is a cached `vi.fn()`                                            |
| `Mocked<T>`             | `{ [K in keyof T]: T[K] extends (...a: infer A) => infer R ? Mock<(...a: A) => R> : T[K] }`                                                                               | typed mock view                                                                                         |

## Usage

```ts
import { createFastifyTestApp, createMock } from '@app/testing';

const users = createMock<UsersPort>({ getUser: async (id: string) => ({ id, email: 'a@b.io' }) });

const app = await createFastifyTestApp(
  Test.createTestingModule({ imports: [IdentityApiModule.forLocal()] })
    .overrideProvider(UsersPort)
    .useValue(users),
  (app) => app.use(/* global middleware, ws adapter, … */),
);

const res = await app.inject({ method: 'GET', url: '/v1/users/123' });
expect(users.getUser).toHaveBeenCalledWith('123');
await app.close();

// auto-mock every unresolved dependency
Test.createTestingModule({ providers: [SomeHandler] }).useMocker(() => createMock());
```

## Environment variables

None.

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

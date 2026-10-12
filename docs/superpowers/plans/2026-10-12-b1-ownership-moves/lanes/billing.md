# B1 lane: billing, files and the gRPC client URLs

Seven tasks. Inside the lane: billing-1 → billing-2 → billing-3 → billing-4. billing-5 runs before the
transport/contracts task that rewrites the three `XApiModule.forRemote()` calls; billing-6 runs right
after it. billing-7 is independent. The cross-lane order is in `ordering`.

Conventions for every task:

- Paths are relative to the repo root. Line numbers come from `7040115` (after H) and are only
  hints, because D and F land first. Always match on the quoted text.
- "Old → New" blocks are exact replacements. Change nothing else in files that D, F or other
  lanes also touch.
- After editing TypeScript, run `npx biome check --write <files>`. It sorts imports and exports
  the way `biome ci` expects. After editing Markdown, run `npx prettier --write <files>` so the
  tables re-align.

---

### Task billing-1: Payment.user composed in the apps (PaymentUserFieldResolver)

**Files:**
- Create: `apps/monolith/src/graphql/payment-user.resolver.ts`
- Create: `apps/gateway/src/graphql/payment-user.resolver.ts`
- Create: `apps/monolith/test/payment-user.e2e-spec.ts`
- Create: `apps/gateway/test/payment-user.e2e-spec.ts`
- Modify: `apps/monolith/src/app.module.ts:33,93` (one import, one provider)
- Modify: `apps/gateway/src/app.module.ts:21,62` (one import, one provider)
- Modify: `apps/monolith/package.json:47,62` / `apps/gateway/package.json:41,54`
- Modify: `apps/monolith/test/support/monolith-e2e-app.ts:26-31,44,55,60`
- Modify: `apps/gateway/test/support/gateway-e2e-app.ts:1,37,44,68-69`
- Modify: `domains/billing/src/presentation/graphql/billing.resolver.ts:1-5,17-21,60-68`
- Modify: `domains/billing/src/presentation/graphql/billing.resolver.spec.ts:1-24,37-55,65,136,156,160-189,268-272`
- Modify: `domains/billing/src/billing.modules.spec.ts:1-4,12`
- Modify: `domains/billing/src/presentation/graphql/models/payment.model.ts:26`
- Modify: `domains/billing/src/billing-api.module.ts:25-28`
- Modify: `domains/billing/package.json:28,44`
- Delete: `domains/billing/src/billing-identity.composition.spec.ts` (replaced by the two app e2e specs)
- Modify (comments only): `domains/identity/src/presentation/graphql/models/user.model.ts:6-9`, `domains/identity/src/presentation/graphql/users-loader.registrar.ts:9,19`, `domains/identity/src/index.ts:77`, `domains/identity/src/identity.constants.ts:39`
- Modify (docs): `domains/billing/README.md:63-64,111,230,233-235,247`, `domains/identity/README.md:235-237`, `apps/billing-service/README.md:15-17`, `apps/monolith/README.md:95,113`, `apps/gateway/README.md:78,90,108,113-114`, `docs/ARCHITECTURE.md:163`, `docs/PERFORMANCE.md:244`
- Modify: `bun.lock` (via `bun install`)
- Test: `domains/billing/src/presentation/graphql/billing.resolver.spec.ts`, `apps/monolith/test/payment-user.e2e-spec.ts`, `apps/gateway/test/payment-user.e2e-spec.ts`

**Interfaces:**
- Consumes:
  - from `@domain/identity`: `USERS_LOADER` (the literal `'users'`) and `UserModel`;
  - `PaymentModel` from `@domain/billing`; `GraphqlLoaders` and `Loader(name)` from `@platform/graphql`;
  - the e2e harness shapes:
    - `createMonolithE2eApp()` returns `{ app, identity: { store: { users: Map<string, UserSnapshot> }, users: UsersRepository } }`;
    - `createGatewayE2eApp()` returns `{ app, identity: FakeIdentityState }`, where `FakeIdentityState` has `setRoles(id, roles)` and `calls: string[]`.
- Produces:
  - `class PaymentUserFieldResolver` in `apps/monolith/src/graphql/payment-user.resolver.ts` and in `apps/gateway/src/graphql/payment-user.resolver.ts`:
    - decorated `@Resolver(() => PaymentModel)`;
    - field `@ResolveField('user', () => UserModel, { nullable: true, complexity: 5 })`;
    - method `user(payment: PaymentModel, users: GraphqlLoaders['users']): Promise<User | null>`.
  - `interface MonolithE2eOptions { postgresRows?: (sql: string, params: unknown[]) => FakeRows }` and `createMonolithE2eApp(options?: MonolithE2eOptions)`.
  - `interface GatewayE2eOptions { billing?: BillingPort }` and `createGatewayE2eApp(options?: GatewayE2eOptions)`.
  - `@domain/billing` no longer depends on `@domain/identity` or `dataloader`, and its GraphQL `Payment` type has no `user` field.

- [ ] **Step 1: Write the failing billing schema test.** In `domains/billing/src/presentation/graphql/billing.resolver.spec.ts` (keep the identity mock for now):

Old:
```ts
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Test } from '@nestjs/testing';
```
New:
```ts
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { GraphQLSchemaHost } from '@nestjs/graphql';
import { Test } from '@nestjs/testing';
```
Old:
```ts
import DataLoader from 'dataloader';
```
New:
```ts
import DataLoader from 'dataloader';
import { printSchema } from 'graphql';
```
Old (end of file):
```ts
      expect(body.errors?.[0]?.extensions?.status).toBe(400);
      expect(port.createCheckoutSession).not.toHaveBeenCalled();
    });
  });
});
```
New:
```ts
      expect(body.errors?.[0]?.extensions?.status).toBe(400);
      expect(port.createCheckoutSession).not.toHaveBeenCalled();
    });
  });

  describe('schema', () => {
    it('exposes the owner as Payment.userId only: the apps compose Payment.user', () => {
      const sdl = printSchema(app.get(GraphQLSchemaHost).schema);

      expect(sdl).toMatch(/type Payment \{[^}]*\buserId: UUID!/);
      expect(sdl).not.toMatch(/type Payment \{[^}]*\buser:/);
    });
  });
});
```

- [ ] **Step 2: Run it.** `npx vitest run --project billing billing.resolver.spec`. Expected: FAIL with
  1 failed test, `… > schema > exposes the owner as Payment.userId only: the apps compose Payment.user`,
  and `AssertionError: expected '…type Payment {…user: User…' not to match /type Payment \{[^}]*\buser:/`.
  Every other test passes.

- [ ] **Step 3: Give the two e2e harnesses the seams the new specs need.**
  - In `apps/monolith/test/support/monolith-e2e-app.ts`:

Old:
```ts
import {
  createFakeCassandra,
  createFakePostgres,
  createFakeQueue,
  createL1OnlyCache,
} from './fake-infrastructure.js';
```
New:
```ts
import {
  createFakeCassandra,
  createFakePostgres,
  createFakeQueue,
  createL1OnlyCache,
  type FakeRows,
} from './fake-infrastructure.js';
```
Old:
```ts
 * | `DRIZZLE`                                  | real drizzle over a fake postgres.js client  |
```
New:
```ts
 * | `DRIZZLE`                                  | real drizzle over a fake postgres.js client (rows: `options.postgresRows`) |
```
Old:
```ts
export async function createMonolithE2eApp() {
```
New:
```ts
export interface MonolithE2eOptions {
  /** Rows the fake Postgres answers a statement with (`sql` whitespace-normalised); default none. */
  postgresRows?: (sql: string, params: unknown[]) => FakeRows;
}

export async function createMonolithE2eApp(options: MonolithE2eOptions = {}) {
```
Old:
```ts
  const postgres = createFakePostgres({ ...identitySchema, ...billingSchema });
```
New:
```ts
  const postgres = createFakePostgres(
    { ...identitySchema, ...billingSchema },
    options.postgresRows,
  );
```
  - In `apps/gateway/test/support/gateway-e2e-app.ts`:

Old:
```ts
import { AuthPort, UsersPort } from '@domain/identity';
```
New:
```ts
import { BillingPort } from '@domain/billing';
import { AuthPort, UsersPort } from '@domain/identity';
```
Old:
```ts
 * | `BillingPort`                     | NOT faked: the real gRPC adapter → a dead upstream     |
```
New:
```ts
 * | `BillingPort`                     | the real gRPC adapter → a dead upstream; or `options.billing` |
```
Old:
```ts
export async function createGatewayE2eApp() {
```
New:
```ts
export interface GatewayE2eOptions {
  /** Binds `BillingPort` to this stand-in for billing-service (default: the real gRPC adapter). */
  billing?: BillingPort;
}

export async function createGatewayE2eApp(options: GatewayE2eOptions = {}) {
```
Old:
```ts
    .overrideProvider(StorageService)
    .useValue(storage);
```
New:
```ts
    .overrideProvider(StorageService)
    .useValue(storage);
  if (options.billing !== undefined) builder.overrideProvider(BillingPort).useValue(options.billing);
```

- [ ] **Step 4: Write the failing monolith e2e spec.** It takes over from `billing-identity.composition.spec.ts`. Create `apps/monolith/test/payment-user.e2e-spec.ts`:
```ts
/*
 * Payment.user in the monolith topology. Billing exposes a payment's owner as `Payment.userId`
 * only; the composition root adds `Payment.user` (`src/graphql/payment-user.resolver.ts`) and
 * resolves it through identity's `users` DataLoader → UsersLocalAdapter → QueryBus →
 * GetUsersByIds → UsersRepository, in ONE batched lookup per operation. Payments come from the
 * fake Postgres (rows answered by position, as postgres.js does), users from the in-memory
 * identity store, registered through the REST API.
 */
await vi.hoisted(async () => {
  const { MONOLITH_E2E_ENV } = await import('./support/e2e-env.js');
  Object.assign(process.env, MONOLITH_E2E_ENV);
});

import { PaymentStatus, payments } from '@domain/billing';
import { GraphQLSchemaHost } from '@nestjs/graphql';
import { generateId } from '@platform/common';
import { getTableColumns } from 'drizzle-orm';
import { printSchema } from 'graphql';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PaymentUserFieldResolver } from '../src/graphql/payment-user.resolver.js';
import type { FakeRows } from './support/fake-infrastructure.js';
import { bearer, graphql } from './support/http.js';
import { createMonolithE2eApp, type MonolithE2e } from './support/monolith-e2e-app.js';

interface AuthTokensBody {
  accessToken: string;
  user: { id: string; email: string; displayName: string };
}

interface PaymentsBody {
  data?: {
    payments: {
      items: {
        id: string;
        userId: string;
        user: { id: string; email: string; displayName: string } | null;
      }[];
      nextCursor: string | null;
    };
  };
  errors?: unknown[];
}

const PASSWORD = 'correct horse battery staple';
const PAYMENTS_QUERY = /* GraphQL */ `
  query Payments {
    payments(all: true, limit: 10) {
      items {
        id
        userId
        user { id email displayName }
      }
      nextCursor
    }
  }
`;
const AT = '2026-09-01T10:00:00.000Z';

/** A paid `payments` row as postgres.js returns it: values in column order, int8 as a string. */
function paymentRow(userId: string): FakeRows[number] {
  const values: Record<string, unknown> = {
    id: generateId(),
    userId,
    priceId: 'price_e2e',
    quantity: 1,
    amountTotal: '2500',
    currency: 'usd',
    status: PaymentStatus.Succeeded,
    stripeCheckoutSessionId: `cs_e2e_${generateId()}`,
    paidAt: AT,
    version: 1,
    createdAt: AT,
    updatedAt: AT,
  };
  return Object.fromEntries(
    Object.keys(getTableColumns(payments)).map((column) => [column, values[column] ?? null]),
  );
}

describe('Payment.user in the monolith (app-level resolver over the local ports)', () => {
  let e2e: MonolithE2e;
  let paymentRows: FakeRows = [];
  let ada: AuthTokensBody;
  let alan: AuthTokensBody;
  let adminToken: string;

  const inject = (...args: Parameters<MonolithE2e['app']['inject']>) => e2e.app.inject(...args);

  const register = async (email: string, displayName: string): Promise<AuthTokensBody> => {
    const response = await inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email, password: PASSWORD, displayName },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<AuthTokensBody>();
  };

  const queryPayments = async (): Promise<PaymentsBody> => {
    const response = await inject(graphql(PAYMENTS_QUERY, undefined, bearer(adminToken)));
    expect(response.statusCode, response.body).toBe(200);
    return response.json<PaymentsBody>();
  };

  beforeAll(async () => {
    e2e = await createMonolithE2eApp({
      postgresRows: (sql) =>
        sql.startsWith('select') && sql.includes('"payments"') ? paymentRows : [],
    });
    ada = await register('ada@example.com', 'Ada');
    alan = await register('alan@example.com', 'Alan');
    // payments(all: true) needs billing:read-all: promote Ada, then log in again for the new roles.
    const stored = e2e.identity.store.users.get(ada.user.id);
    if (stored === undefined) throw new Error('Ada was not persisted');
    e2e.identity.store.users.set(ada.user.id, { ...stored, roles: ['admin'] });
    const login = await inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'ada@example.com', password: PASSWORD },
    });
    expect(login.statusCode, login.body).toBe(200);
    adminToken = login.json<AuthTokensBody>().accessToken;
  });

  afterAll(async () => {
    await e2e?.app.close();
  });

  it('registers PaymentUserFieldResolver: one schema where Payment.user is identity’s User', () => {
    expect(e2e.app.get(PaymentUserFieldResolver)).toBeInstanceOf(PaymentUserFieldResolver);
    const sdl = printSchema(e2e.app.get(GraphQLSchemaHost).schema);
    expect(sdl).toMatch(/type Payment \{[^}]*\buser: User\b/);
    expect(sdl).toMatch(/type Payment \{[^}]*\buserId: UUID!/);
    expect(sdl.match(/^type User \{/gm)).toHaveLength(1);
  });

  it('resolves Payment.user for a page of payments with ONE batched users lookup', async () => {
    paymentRows = [paymentRow(ada.user.id), paymentRow(alan.user.id), paymentRow(ada.user.id)];
    const findByIds = vi.spyOn(e2e.identity.users, 'findByIds');

    const body = await queryPayments();

    expect(body.errors).toBeUndefined();
    const items = body.data?.payments.items ?? [];
    expect(items.map((payment) => payment.user?.email)).toEqual([
      'ada@example.com',
      'alan@example.com',
      'ada@example.com',
    ]);
    expect(items.every((payment) => payment.user?.id === payment.userId)).toBe(true);
    expect(items[1]?.user).toEqual({
      id: alan.user.id,
      email: 'alan@example.com',
      displayName: 'Alan',
    });
    // Three payments, two distinct owners: one GetUsersByIds query, one repository call.
    expect(findByIds).toHaveBeenCalledTimes(1);
    expect([...(findByIds.mock.calls[0]?.[0] ?? [])].sort()).toEqual(
      [ada.user.id, alan.user.id].sort(),
    );
  });

  it('resolves user to null when the owner no longer exists', async () => {
    const gone = generateId();
    paymentRows = [paymentRow(gone)];

    const body = await queryPayments();

    expect(body.errors).toBeUndefined();
    expect(body.data?.payments.items).toEqual([
      expect.objectContaining({ userId: gone, user: null }),
    ]);
  });
});
```

- [ ] **Step 5: Write the failing gateway e2e spec.** Create `apps/gateway/test/payment-user.e2e-spec.ts`:
```ts
/*
 * Payment.user in the microservices topology. The gateway composes `Payment.user`
 * (`src/graphql/payment-user.resolver.ts`) over two remote ports. Billing's port lists the payments
 * (a stub here, in place of billing-service; billing's roundtrip spec covers the real gRPC hop).
 * Identity's `users` DataLoader resolves the owners through UsersPort (the fake identity-service)
 * in ONE GetUsersByIds call per operation.
 */
await vi.hoisted(async () => {
  const { GATEWAY_E2E_ENV } = await import('./support/e2e-env.js');
  Object.assign(process.env, GATEWAY_E2E_ENV);
});

import { GraphQLSchemaHost } from '@nestjs/graphql';
import { generateId } from '@platform/common';
import { printSchema } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaymentUserFieldResolver } from '../src/graphql/payment-user.resolver.js';
import { createGatewayE2eApp, type GatewayE2e } from './support/gateway-e2e-app.js';
import { bearer, graphql } from './support/http.js';

interface AuthTokensBody {
  accessToken: string;
  user: { id: string; email: string; displayName: string };
}

interface PaymentsBody {
  data?: {
    payments: {
      items: {
        id: string;
        userId: string;
        user: { id: string; email: string; displayName: string } | null;
      }[];
      nextCursor: string | null;
    };
  };
  errors?: unknown[];
}

const PASSWORD = 'a very long passphrase';
const PAYMENTS_QUERY = /* GraphQL */ `
  query Payments {
    payments(all: true, limit: 10) {
      items {
        id
        userId
        user { id email displayName }
      }
      nextCursor
    }
  }
`;

/** billing-service, stubbed at its port: each test sets the page once the owners exist. */
const billing = {
  createCheckoutSession: vi.fn(),
  handleStripeWebhook: vi.fn(),
  listPayments: vi.fn(),
};

/** A `billing.v1.Payment` as `BillingPort.listPayments` returns it. */
const payment = (userId: string) => ({
  id: generateId(),
  userId,
  status: 'succeeded',
  amountTotal: '2500',
  currency: 'usd',
  priceId: 'price_e2e',
  quantity: 1,
  createdAt: new Date('2026-09-01T10:00:00.000Z'),
});

describe('Payment.user in the gateway (app-level resolver over the remote ports)', () => {
  let e2e: GatewayE2e;
  let grace: AuthTokensBody;
  let alan: AuthTokensBody;
  let adminToken: string;

  const inject = (...args: Parameters<GatewayE2e['app']['inject']>) => e2e.app.inject(...args);

  const register = async (email: string, displayName: string): Promise<AuthTokensBody> => {
    const response = await inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email, password: PASSWORD, displayName },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<AuthTokensBody>();
  };

  const queryPayments = async (): Promise<PaymentsBody> => {
    const response = await inject(graphql(PAYMENTS_QUERY, undefined, bearer(adminToken)));
    expect(response.statusCode, response.body).toBe(200);
    return response.json<PaymentsBody>();
  };

  beforeAll(async () => {
    e2e = await createGatewayE2eApp({ billing });
    grace = await register('grace@example.com', 'Grace');
    alan = await register('alan@example.com', 'Alan');
    // payments(all: true) needs billing:read-all: promote Grace in the fake identity-service.
    e2e.identity.setRoles(grace.user.id, ['admin']);
    const login = await inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'grace@example.com', password: PASSWORD },
    });
    expect(login.statusCode, login.body).toBe(200);
    adminToken = login.json<AuthTokensBody>().accessToken;
  });

  afterAll(async () => {
    await e2e?.app.close();
  });

  beforeEach(() => {
    e2e.identity.calls.length = 0;
  });

  it('registers PaymentUserFieldResolver: one schema where Payment.user is identity’s User', () => {
    expect(e2e.app.get(PaymentUserFieldResolver)).toBeInstanceOf(PaymentUserFieldResolver);
    const sdl = printSchema(e2e.app.get(GraphQLSchemaHost).schema);
    expect(sdl).toMatch(/type Payment \{[^}]*\buser: User\b/);
    expect(sdl).toMatch(/type Payment \{[^}]*\buserId: UUID!/);
    expect(sdl.match(/^type User \{/gm)).toHaveLength(1);
  });

  it('resolves Payment.user for a page with ONE GetUsersByIds call to identity-service', async () => {
    billing.listPayments.mockResolvedValue({
      items: [payment(grace.user.id), payment(alan.user.id), payment(grace.user.id)],
    });

    const body = await queryPayments();

    expect(body.errors).toBeUndefined();
    expect(billing.listPayments).toHaveBeenCalledWith({ userId: undefined, limit: 10 });
    const items = body.data?.payments.items ?? [];
    expect(items.map((item) => item.user?.email)).toEqual([
      'grace@example.com',
      'alan@example.com',
      'grace@example.com',
    ]);
    expect(items[1]?.user).toEqual({
      id: alan.user.id,
      email: 'alan@example.com',
      displayName: 'Alan',
    });
    expect(e2e.identity.calls.filter((call) => call === 'UsersService.GetUsersByIds')).toHaveLength(
      1,
    );
  });

  it('resolves user to null when the owner no longer exists', async () => {
    const gone = generateId();
    billing.listPayments.mockResolvedValue({ items: [payment(gone)] });

    const body = await queryPayments();

    expect(body.errors).toBeUndefined();
    expect(body.data?.payments.items).toEqual([
      expect.objectContaining({ userId: gone, user: null }),
    ]);
  });
});
```

- [ ] **Step 6: Run them.** `npx vitest run --project monolith:e2e --project gateway:e2e payment-user`. Expected:
  FAIL. Both files fail to load with
  `Error: Failed to load url ../src/graphql/payment-user.resolver.js (resolved id: …) in …/test/payment-user.e2e-spec.ts. Does the file exist?`.

- [ ] **Step 7: Create the resolver in both apps.** Create `apps/monolith/src/graphql/payment-user.resolver.ts`:
```ts
import { PaymentModel } from '@domain/billing';
import { USERS_LOADER, UserModel } from '@domain/identity';
import { Parent, ResolveField, Resolver } from '@nestjs/graphql';
import { type GraphqlLoaders, Loader } from '@platform/graphql';

/** Identity's `users` DataLoader, typed by identity's `GraphqlLoaders['users']` augmentation. */
type UsersLoader = GraphqlLoaders[typeof USERS_LOADER];

/**
 * `Payment.user`: the one GraphQL field that spans two bounded contexts (billing → identity). It
 * lives in the composition root so that neither domain imports the other: billing exposes the owner
 * as `Payment.userId`, identity registers the `users` DataLoader (`IdentityApiModule`), and this
 * resolver joins them. In the monolith the loader batches into ONE in-process `GetUsersByIds`
 * query per GraphQL operation; the gateway registers the same resolver over its remote ports.
 */
@Resolver(() => PaymentModel)
export class PaymentUserFieldResolver {
  /** `null` when the owner no longer exists. */
  @ResolveField('user', () => UserModel, { nullable: true, complexity: 5 })
  user(
    @Parent() payment: PaymentModel,
    @Loader(USERS_LOADER) users: UsersLoader,
  ): ReturnType<UsersLoader['load']> {
    return users.load(payment.userId);
  }
}
```
Create `apps/gateway/src/graphql/payment-user.resolver.ts`:
```ts
import { PaymentModel } from '@domain/billing';
import { USERS_LOADER, UserModel } from '@domain/identity';
import { Parent, ResolveField, Resolver } from '@nestjs/graphql';
import { type GraphqlLoaders, Loader } from '@platform/graphql';

/** Identity's `users` DataLoader, typed by identity's `GraphqlLoaders['users']` augmentation. */
type UsersLoader = GraphqlLoaders[typeof USERS_LOADER];

/**
 * `Payment.user`: the one GraphQL field that spans two bounded contexts (billing → identity). It
 * lives in the composition root so that neither domain imports the other: billing exposes the owner
 * as `Payment.userId`, identity registers the `users` DataLoader (`IdentityApiModule`), and this
 * resolver joins them. In the gateway the loader batches into ONE `UsersService.GetUsersByIds` RPC
 * to identity-service per GraphQL operation; the monolith registers the same resolver locally.
 */
@Resolver(() => PaymentModel)
export class PaymentUserFieldResolver {
  /** `null` when the owner no longer exists. */
  @ResolveField('user', () => UserModel, { nullable: true, complexity: 5 })
  user(
    @Parent() payment: PaymentModel,
    @Loader(USERS_LOADER) users: UsersLoader,
  ): ReturnType<UsersLoader['load']> {
    return users.load(payment.userId);
  }
}
```

- [ ] **Step 8: Register it in both AppModules and declare the new dependencies.**
  - In `apps/monolith/src/app.module.ts`:

Old:
```ts
import { KafkaProducerModule } from '@platform/transport';
```
New:
```ts
import { KafkaProducerModule } from '@platform/transport';
import { PaymentUserFieldResolver } from './graphql/payment-user.resolver.js';
```
Old (anchor on this line only; F20 may change the comment below it):
```ts
  providers: [
```
New:
```ts
  providers: [
    // `Payment.user` (billing → identity): the one cross-domain GraphQL field is composed here.
    PaymentUserFieldResolver,
```
  - In `apps/gateway/src/app.module.ts`:

Old:
```ts
import { StorageModule } from '@platform/storage';
```
New:
```ts
import { StorageModule } from '@platform/storage';
import { PaymentUserFieldResolver } from './graphql/payment-user.resolver.js';
```
  Then make the same `  providers: [` replacement as in the monolith.
  - In `apps/monolith/package.json`:
    - in `dependencies`, after `"@nestjs/cqrs": "catalog:",`, add `"@nestjs/graphql": "catalog:",`;
    - in `devDependencies`, after `"drizzle-orm": "catalog:",`, add `"graphql": "catalog:",`.
  - In `apps/gateway/package.json`:
    - in `dependencies`, after `"@nestjs/config": "catalog:",`, add `"@nestjs/graphql": "catalog:",`;
    - in `devDependencies`, after `"cache-manager": "catalog:",`, add `"graphql": "catalog:",`.

- [ ] **Step 9: Remove the field from billing.** In `domains/billing/src/presentation/graphql/billing.resolver.ts`:

Old:
```ts
import { USERS_LOADER, UserModel } from '@domain/identity';
import { Args, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { type AuthUser, CurrentUser, Permission, RequirePermissions } from '@platform/auth';
import type { User } from '@platform/contracts';
import { type GraphqlLoaders, Loader } from '@platform/graphql';
import { BillingPort } from '../../application/ports/billing.port.js';
```
New:
```ts
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { type AuthUser, CurrentUser, Permission, RequirePermissions } from '@platform/auth';
import { BillingPort } from '../../application/ports/billing.port.js';
```
Old:
```ts
/**
 * `payments(all, limit, cursor)` (a keyset-paginated connection) and `createCheckoutSession(input)`. Authentication/RBAC come from the
 * global, context-aware guards; `Payment.user` is resolved through identity's `users` DataLoader,
 * so a page of N payments costs ONE batched user lookup (no N+1).
 */
```
New:
```ts
/**
 * `payments(all, limit, cursor)` (a keyset-paginated connection) and `createCheckoutSession(input)`.
 * Authentication/RBAC come from the global, context-aware guards. A payment's owner is exposed as
 * `Payment.userId` only: the apps compose `Payment.user` (`PaymentUserFieldResolver`, over
 * identity's `users` DataLoader), so billing never imports identity.
 */
```
Old:
```ts
      idempotencyKey: input.idempotencyKey ?? undefined,
    });
  }

  /** Typed by identity's `GraphqlLoaders['users']` augmentation; `null` for a deleted user. */
  @ResolveField('user', () => UserModel, { nullable: true, complexity: 5 })
  user(
    @Parent() payment: PaymentModel,
    @Loader(USERS_LOADER) users: GraphqlLoaders[typeof USERS_LOADER],
  ): Promise<User | null> {
    return users.load(payment.userId);
  }
}
```
New:
```ts
      idempotencyKey: input.idempotencyKey ?? undefined,
    });
  }
}
```
  - In `domains/billing/src/presentation/graphql/models/payment.model.ts`:

Old:
```ts
  /** Parent key of the batched `user` field (DataLoader). */
```
New:
```ts
  /** Owner. The apps compose `Payment.user` from it (identity's `users` DataLoader). */
```
  - In `domains/billing/src/billing-api.module.ts`:

Old:
```ts
 * (both validation pipes + problem+json filter), `AppGraphqlModule.forRootAsync()` plus identity's
 * API module (it registers the `users` DataLoader behind `Payment.user`), and an HTTP app created
 * with `rawBody: true` for the Stripe webhook.
```
New:
```ts
 * (both validation pipes + problem+json filter), `AppGraphqlModule.forRootAsync()` and an HTTP app
 * created with `rawBody: true` for the Stripe webhook. `Payment.user` is not billing's: the apps
 * compose it (`PaymentUserFieldResolver`) over identity's `users` DataLoader.
```

- [ ] **Step 10: Drop billing's identity dependency, its mocks and the old composition spec.**
  - In `billing.resolver.spec.ts`:

Old:
```ts
// Isolate from the identity context: only its `UserModel` GraphQL type is needed here.
vi.mock('@domain/identity', async () => {
  const { Field, ID, ObjectType } = await import('@nestjs/graphql');
  @ObjectType('User')
  class UserModel {
    @Field(() => ID)
    id: string;

    @Field()
    displayName: string;
  }
  return { UserModel, USERS_LOADER: 'users' };
});

import { Injectable, type OnModuleInit } from '@nestjs/common';
import { GraphQLSchemaHost } from '@nestjs/graphql';
```
New:
```ts
import { GraphQLSchemaHost } from '@nestjs/graphql';
```
Old: `import { AppGraphqlModule, DataLoaderRegistry } from '@platform/graphql';`
New: `import { AppGraphqlModule } from '@platform/graphql';`

Old:
```ts
import DataLoader from 'dataloader';
import { printSchema } from 'graphql';
```
New:
```ts
import { printSchema } from 'graphql';
```
Old:
```ts
/** What identity's registrar does: one batched `getUsersByIds` per operation. */
const userBatches: string[][] = [];

@Injectable()
class UsersLoaderStub implements OnModuleInit {
  constructor(private readonly registry: DataLoaderRegistry) {}

  onModuleInit(): void {
    this.registry.register(
      'users',
      () =>
        new DataLoader<string, { id: string; displayName: string } | null>(async (ids) => {
          userBatches.push([...ids]);
          return ids.map((id) => ({ id, displayName: `user ${id.slice(-4)}` }));
        }),
    );
  }
}

const PAYMENTS_QUERY
```
New:
```ts
const PAYMENTS_QUERY
```
Old: `        user { id displayName }` (inside `PAYMENTS_QUERY`)
New: `        userId`

Old:
```ts
        BillingResolver,
        UsersLoaderStub,
```
New:
```ts
        BillingResolver,
```
Old:
```ts
    port.createCheckoutSession.mockReset();
    userBatches.length = 0;
```
New:
```ts
    port.createCheckoutSession.mockReset();
```
Old:
```ts
    it("returns the caller's payments with users resolved in ONE batch", async () => {
```
New:
```ts
    it("returns the caller's payments, each with its owner's userId", async () => {
```
Old:
```ts
        createdAt: '2026-09-01T10:00:00.000Z',
        user: { id: user.id },
      });
      expect(userBatches).toEqual([[user.id, other]]);
```
New:
```ts
        createdAt: '2026-09-01T10:00:00.000Z',
        userId: user.id,
      });
      expect(items[2]).toMatchObject({ userId: other });
```
  - In `domains/billing/src/billing.modules.spec.ts`, delete the first four lines:
```ts
// Only identity's `UserModel` GraphQL type is referenced (by BillingResolver); keep the identity
// context out of this wiring test.
vi.mock('@domain/identity', () => ({ UserModel: class UserModel {}, USERS_LOADER: 'users' }));

```
    Then change `import { afterEach, describe, expect, it, vi } from 'vitest';` to
    `import { afterEach, describe, expect, it } from 'vitest';`.
  - `git rm domains/billing/src/billing-identity.composition.spec.ts`
  - In `domains/billing/package.json`, delete the lines `"@domain/identity": "workspace:*",` and
    `"dataloader": "catalog:",`.
  - Run `bun install` (rewrites `bun.lock`), then
    `npx biome check --write apps/monolith/src apps/gateway/src apps/monolith/test apps/gateway/test domains/billing/src`.

- [ ] **Step 11: Run the tests.**
  `npx vitest run --project billing --project monolith --project gateway --project monolith:e2e --project gateway:e2e`.
  Expected: PASS, including `billing.resolver.spec.ts > schema` and the 3 tests of each
  `payment-user.e2e-spec.ts`. Then `git grep -n "@domain/identity" -- domains/billing` must print nothing.

- [ ] **Step 12: Point identity's comments at the new seam.** These are comment-only edits.
  - `domains/identity/src/presentation/graphql/models/user.model.ts`:

Old:
```ts
 * GraphQL `User`. Exported for other domains' fields (e.g. billing's `Payment.user`, resolved
 * through the `users` DataLoader).
```
New:
```ts
 * GraphQL `User`. Exported for the cross-domain field the apps compose (`Payment.user` in
 * `PaymentUserFieldResolver`, resolved through the `users` DataLoader).
```
  - `domains/identity/src/presentation/graphql/users-loader.registrar.ts`:
    - replace `for every domain that imports this lib` with `for every package that imports this lib`;
    - replace `billing's \`Payment.user\` over a list of payments` with `` `Payment.user` (composed in the apps) over a list of payments``.
  - `domains/identity/src/index.ts`:
    - old: `// Presentation: GraphQL types other domains reference (billing's \`Payment.user\`).`
    - new: `// Presentation: GraphQL types the apps compose with (\`Payment.user\` in \`PaymentUserFieldResolver\`).`
  - `domains/identity/src/identity.constants.ts`: replace `(\`@Loader(USERS_LOADER)\` in other domains)` with `(\`@Loader(USERS_LOADER)\` in the apps' \`PaymentUserFieldResolver\`)`.

- [ ] **Step 13: Update the docs.**
  - `domains/billing/README.md`:
    - Old:
      ```md
      - `AppGraphqlModule.forRootAsync()` and **identity's Api module**: it registers the `users` DataLoader behind
        `Payment.user` and the `User` GraphQL type.
      ```
      New:
      ```md
      - `AppGraphqlModule.forRootAsync()`. Billing exposes a payment's owner as `Payment.userId` only: the apps add
        `Payment.user` (`PaymentUserFieldResolver` in `apps/monolith` and `apps/gateway`, over identity's `users`
        DataLoader), so billing never imports identity.
      ```
    - In the GraphQL block, change `  user: User # batched through identity's \`users\` DataLoader` to
      `  user: User # added by the apps (PaymentUserFieldResolver), batched through identity's \`users\` DataLoader`.
    - Tests:
      - Change `` - `billing.resolver.spec.ts` — Apollo on Fastify: payments + batched `user` field, RBAC, input validation.`` to
        `` - `billing.resolver.spec.ts` — Apollo on Fastify: payments (owner as `userId`; billing defines no `user` field), RBAC, input validation.``
      - Replace the three-line `billing-identity.composition.spec.ts` bullet with:
        ```md
        - `Payment.user` is tested where it is composed: `apps/monolith/test/payment-user.e2e-spec.ts` (local ports, ONE
          batched `GetUsersByIds`) and `apps/gateway/test/payment-user.e2e-spec.ts` (remote ports, ONE `GetUsersByIds` RPC).
        ```
    - Gotchas: delete the bullet `` - `@domain/billing`'s barrel imports `@domain/identity` (for `UserModel`), so billing-service also loads identity's code.``
  - `domains/identity/README.md`:
    - Old:
      ```md
        `IdentityGrpcModule`. Billing's `billing-identity.composition.spec.ts` composes this lib with
        billing in one GraphQL app (`Payment.user` through the `users` loader).
      ```
      New:
      ```md
        `IdentityGrpcModule`. `apps/monolith/test/payment-user.e2e-spec.ts` and
        `apps/gateway/test/payment-user.e2e-spec.ts` compose this lib with billing in one GraphQL schema
        (`Payment.user` through the `users` loader).
      ```
  - `apps/billing-service/README.md`:
    - Old:
      ```md
      The domain logic lives in [`@domain/billing`](../../domains/billing); this app is only the composition
      root. (`@domain/billing` imports `@domain/identity` for the GraphQL `Payment.user` field, so its code is
      loaded here too, though unused.)
      ```
      New:
      ```md
      The domain logic lives in [`@domain/billing`](../../domains/billing); this app is only the composition
      root.
      ```
  - `apps/monolith/README.md` and `apps/gateway/README.md`:
    - In each, insert this bullet immediately above the bullet that starts with
      `` - `src/main.ts` — `runClustered` ``:
      ```md
      - `src/graphql/payment-user.resolver.ts` — `PaymentUserFieldResolver` adds `Payment.user` (billing → identity)
        through identity's `users` DataLoader: the one cross-domain GraphQL field lives in the composition root, so
        billing never imports identity.
      ```
    - In each Tests block, change `# e2e (test/app.e2e-spec.ts)` to `# e2e (test/*.e2e-spec.ts)`.
    - `apps/gateway/README.md` only:
      - In the GraphQL row, change ``(`Payment.user` batched by the `users` DataLoader)`` to
        ``(`Payment.user` composed here by `PaymentUserFieldResolver`, batched by the `users` DataLoader)``.
      - Change `to assert the 503 mapping.` to
        ``to assert the 503 mapping; `test/payment-user.e2e-spec.ts` binds `BillingPort` to a stub instead (`createGatewayE2eApp({ billing })`) to prove `Payment.user` over the remote ports.``
  - `docs/ARCHITECTURE.md`: under "Composition rules visible in the app modules", insert this bullet after the one
    that starts with `- **The gateway owns no data**`:
    ```md
    - **Cross-domain GraphQL fields live in the apps.** `Payment.user` (billing → identity) is resolved by `PaymentUserFieldResolver` (`apps/monolith/src/graphql`, `apps/gateway/src/graphql`) through identity's `users` DataLoader; billing exposes only `Payment.userId`, so no domain imports another.
    ```
  - `docs/PERFORMANCE.md`: change `(for example \`Payment.user\`)` to
    `(for example \`Payment.user\`, composed in the apps by \`PaymentUserFieldResolver\`)`.
  - Run `npx prettier --write domains/billing/README.md domains/identity/README.md apps/billing-service/README.md apps/monolith/README.md apps/gateway/README.md docs/ARCHITECTURE.md docs/PERFORMANCE.md`.

- [ ] **Step 14: Full check.** `bun run check`. Expected: PASS (biome ci, eslint, prettier --check, tsc,
  `Layer boundaries OK (… packages: apps -> domains -> libs).`).

- [ ] **Step 15: Commit.**
```bash
git add apps/monolith/src/graphql/payment-user.resolver.ts apps/gateway/src/graphql/payment-user.resolver.ts \
  apps/monolith/src/app.module.ts apps/gateway/src/app.module.ts apps/monolith/package.json apps/gateway/package.json bun.lock \
  apps/monolith/test/payment-user.e2e-spec.ts apps/gateway/test/payment-user.e2e-spec.ts \
  apps/monolith/test/support/monolith-e2e-app.ts apps/gateway/test/support/gateway-e2e-app.ts \
  domains/billing/package.json domains/billing/src/billing-api.module.ts domains/billing/src/billing.modules.spec.ts \
  domains/billing/src/presentation/graphql/billing.resolver.ts domains/billing/src/presentation/graphql/billing.resolver.spec.ts \
  domains/billing/src/presentation/graphql/models/payment.model.ts \
  domains/identity/src/identity.constants.ts domains/identity/src/index.ts \
  domains/identity/src/presentation/graphql/models/user.model.ts domains/identity/src/presentation/graphql/users-loader.registrar.ts \
  domains/billing/README.md domains/identity/README.md apps/billing-service/README.md apps/monolith/README.md \
  apps/gateway/README.md docs/ARCHITECTURE.md docs/PERFORMANCE.md
git commit -m "refactor(billing,monolith,gateway): compose Payment.user in the apps" -m "Payment.user is the one GraphQL field that crosses two bounded contexts. It moves out of
billing into PaymentUserFieldResolver, registered by apps/monolith and apps/gateway over
identity's users DataLoader, so @domain/billing no longer depends on @domain/identity (nor on
dataloader). Billing exposes the owner as Payment.userId only; the served schema is unchanged.

billing-identity.composition.spec.ts becomes payment-user e2e specs in both topologies (one
batched GetUsersByIds per operation); the e2e harnesses gain postgresRows (monolith) and
billing (gateway) options." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
(`git rm` already staged the deleted composition spec.)

---

### Task billing-2: Fold @platform/payments into billing's Stripe adapter

**Files:**
- Move: `libs/payments/src/stripe.constants.ts` -> `domains/billing/src/infrastructure/stripe/stripe.constants.ts`
- Move: `libs/payments/src/stripe.errors.ts` -> `domains/billing/src/infrastructure/stripe/stripe.errors.ts`
- Move: `libs/payments/src/stripe.errors.spec.ts` -> `domains/billing/src/infrastructure/stripe/stripe.errors.spec.ts`
- Move: `libs/payments/src/stripe.module.ts` -> `domains/billing/src/infrastructure/stripe/stripe.module.ts`
- Move: `libs/payments/src/stripe.module.spec.ts` -> `domains/billing/src/infrastructure/stripe/stripe.module.spec.ts`
- Move: `libs/payments/src/stripe.service.ts` -> `domains/billing/src/infrastructure/stripe/stripe.service.ts`
- Move: `libs/payments/src/stripe.service.spec.ts` -> `domains/billing/src/infrastructure/stripe/stripe.service.spec.ts`
- Move: `libs/payments/src/stripe.types.ts` -> `domains/billing/src/infrastructure/stripe/stripe.types.ts`
- Delete: `libs/payments/src/index.ts`, `libs/payments/package.json`, `libs/payments/tsconfig.json`, `libs/payments/README.md` (its content moves into the billing README)
- Create: `domains/billing/src/billing.constants.spec.ts`
- Modify: `domains/billing/src/billing.constants.ts:1-13`
- Modify: `domains/billing/src/billing-core.module.ts:15,24-29`
- Modify: `domains/billing/src/index.ts:39` (`// Presentation` anchor)
- Modify: `domains/billing/src/application/commands/create-checkout-session/create-checkout-session.handler.ts:6`, `…/create-checkout-session.handler.spec.ts:8`, `domains/billing/src/application/commands/handle-stripe-webhook/handle-stripe-webhook.handler.ts:7`
- Modify: `domains/billing/src/billing.modules.spec.ts:10,13-17,27-41,62`, `domains/billing/test/billing-test.utils.ts:16`, `domains/billing/test/stripe-webhook.flow.spec.ts:14`
- Modify: `apps/monolith/src/app.module.ts:24,79`, `apps/billing-service/src/app.module.ts:10,40-42`
- Modify: `apps/monolith/package.json:34`, `apps/billing-service/package.json:27`, `domains/billing/package.json:30`, `bun.lock`
- Modify (docs): `domains/billing/README.md:15,24,44,52,68-69,83,154,227`, `apps/billing-service/README.md:30-31`, `apps/monolith/README.md:91`, `docs/ARCHITECTURE.md:55,78,154`, `docs/API.md:306`, `README.md:58,421`, `docs/RELEASING.md:55`
- Test: `domains/billing/src/billing.modules.spec.ts`, `domains/billing/src/billing.constants.spec.ts`, `domains/billing/src/infrastructure/stripe/*.spec.ts`

**Interfaces:**
- Consumes:
  - `stripeConfig` and `StripeConfig` from `@platform/config`, unchanged. They move in billing-3.
  - Runs after billing-1, which deleted `billing-identity.composition.spec.ts`, an importer of `@platform/payments`.
- Produces:
  - `@domain/billing` exports the Stripe adapter:
    - `StripeModule.forRootAsync(): DynamicModule`. It is not global; `BillingCoreModule` imports it.
    - `StripeService`:
      - `createCheckoutSession(input: StripeCheckoutSessionInput, idempotencyKey?: string): Promise<Stripe.Checkout.Session>`;
      - `constructWebhookEvent(payload: Buffer, signature: string | undefined): Stripe.Event`;
      - `readonly client: Stripe`.
    - `createStripeClient(cfg: StripeConfig): Stripe`.
    - `STRIPE_CLIENT` (symbol) and `InjectStripe(): PropertyDecorator & ParameterDecorator`.
    - `STRIPE_WEBHOOK_TOLERANCE_SEC = 300` and `STRIPE_APP_INFO`.
    - `toPaymentDomainException(error: unknown): DomainException | undefined`.
    - `type StripeCheckoutSessionInput`.
  - `BillingErrorCode` gains `INVALID_WEBHOOK_SIGNATURE`, `INVALID_WEBHOOK_PAYLOAD`, `PAYMENT_REQUEST_INVALID`, `PAYMENT_DECLINED`, `PAYMENT_PROVIDER_RATE_LIMITED` and `PAYMENT_PROVIDER_ERROR`. Each value equals its key, as before.
  - Removed: `@platform/payments`, `PaymentErrorCode`, and the `CreateCheckoutSessionInput` type of the facade. The GraphQL input class `CreateCheckoutSessionInput` stays.

- [ ] **Step 1: Write the failing tests.**
  - Create `domains/billing/src/billing.constants.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { BillingErrorCode } from './billing.constants.js';

describe('BillingErrorCode', () => {
  it('owns the Stripe adapter codes too, with their published values', () => {
    expect(BillingErrorCode).toMatchObject({
      INVALID_WEBHOOK_SIGNATURE: 'INVALID_WEBHOOK_SIGNATURE',
      INVALID_WEBHOOK_PAYLOAD: 'INVALID_WEBHOOK_PAYLOAD',
      PAYMENT_REQUEST_INVALID: 'PAYMENT_REQUEST_INVALID',
      PAYMENT_DECLINED: 'PAYMENT_DECLINED',
      IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
      PAYMENT_PROVIDER_RATE_LIMITED: 'PAYMENT_PROVIDER_RATE_LIMITED',
      PAYMENT_PROVIDER_ERROR: 'PAYMENT_PROVIDER_ERROR',
    });
  });

  it('uses every key as its own value (codes are public API: never rename)', () => {
    for (const [key, value] of Object.entries(BillingErrorCode)) expect(value).toBe(key);
  });
});
```
  - In `domains/billing/src/billing.modules.spec.ts`, stop faking Stripe. It must come with the core.

Old:
```ts
import {
  createRecordingDrizzle,
  createTestStripeService,
  installTestTransactionHost,
} from '../test/billing-test.utils.js';
```
New:
```ts
import { createRecordingDrizzle, installTestTransactionHost } from '../test/billing-test.utils.js';
```
Old:
```ts
/** What the apps' global infrastructure modules provide, faked (no Postgres, Kafka, Stripe). */
```
New:
```ts
/**
 * What the apps' global infrastructure modules provide, faked (no Postgres, no Kafka). No Stripe:
 * BillingCoreModule brings its own adapter (a real client from the dev placeholder key, which
 * opens no connection until a call).
 */
```
Old:
```ts
      { provide: TransactionHost, useValue: host },
      { provide: StripeService, useValue: createTestStripeService() },
      { provide: KafkaProducer, useValue: new FakeKafkaProducer() },
    ],
    exports: [DRIZZLE, TransactionHost, StripeService, KafkaProducer],
```
New:
```ts
      { provide: TransactionHost, useValue: host },
      { provide: KafkaProducer, useValue: new FakeKafkaProducer() },
    ],
    exports: [DRIZZLE, TransactionHost, KafkaProducer],
```
Old:
```ts
    expect(context.get(BillingGrpcController)).toBeInstanceOf(BillingGrpcController);
```
New:
```ts
    expect(context.get(BillingGrpcController)).toBeInstanceOf(BillingGrpcController);
    // The Stripe adapter comes with the core, not from an app-level module.
    expect(context.get(StripeService, { strict: false })).toBeInstanceOf(StripeService);
```

- [ ] **Step 2: Run them.** `npx vitest run --project billing billing.constants.spec billing.modules.spec`. Expected: FAIL.
  - `billing.constants.spec.ts > owns the Stripe adapter codes too…` fails with `expected { …(6) } to match object { …(7) }`.
  - `billing.modules.spec.ts > billing-service…` and `> monolith…` fail with
    `Nest can't resolve dependencies of the HandleStripeWebhookHandler (?, …)`, or the same for
    `CreateCheckoutSessionHandler`. The message names `StripeService` and the `BillingCoreModule`
    context.
  - The gateway case passes.

- [ ] **Step 3: Move the sources and delete the package.**
```bash
mkdir -p domains/billing/src/infrastructure/stripe
for f in stripe.constants.ts stripe.errors.ts stripe.errors.spec.ts stripe.module.ts stripe.module.spec.ts \
         stripe.service.ts stripe.service.spec.ts stripe.types.ts; do
  git mv "libs/payments/src/$f" "domains/billing/src/infrastructure/stripe/$f"
done
git rm -r libs/payments
rm -rf libs/payments   # untracked leftovers (dist/, node_modules/.cache) of the deleted package
```

- [ ] **Step 4: Merge the error codes and apply the renames.**
  - `domains/billing/src/billing.constants.ts`:

Old:
```ts
/** Stable error codes of the billing context (`DomainException.code`, surfaced to clients). */
export const BillingErrorCode = {
  PAYMENT_NOT_FOUND: 'PAYMENT_NOT_FOUND',
  /** Same `Idempotency-Key` replayed with a different price/quantity. */
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
```
New:
```ts
/**
 * Stable error codes of the billing context (`DomainException.code`, surfaced to clients),
 * including its Stripe adapter's. Part of the public API: never rename a value.
 */
export const BillingErrorCode = {
  PAYMENT_NOT_FOUND: 'PAYMENT_NOT_FOUND',
  /**
   * Same `Idempotency-Key` replayed with a different price/quantity, or Stripe refusing a reused
   * idempotency key (`StripeIdempotencyError`).
   */
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
```
Old:
```ts
  INVALID_PAYMENT: 'INVALID_PAYMENT',
} as const;
```
New:
```ts
  INVALID_PAYMENT: 'INVALID_PAYMENT',
  /** Missing, forged or stale (> `STRIPE_WEBHOOK_TOLERANCE_SEC`) `Stripe-Signature`. */
  INVALID_WEBHOOK_SIGNATURE: 'INVALID_WEBHOOK_SIGNATURE',
  /** Correctly signed webhook body that is not a JSON event. */
  INVALID_WEBHOOK_PAYLOAD: 'INVALID_WEBHOOK_PAYLOAD',
  /** `StripeInvalidRequestError` (e.g. an unknown price). */
  PAYMENT_REQUEST_INVALID: 'PAYMENT_REQUEST_INVALID',
  /** `StripeCardError` (`details.declineCode`). */
  PAYMENT_DECLINED: 'PAYMENT_DECLINED',
  /** `StripeRateLimitError`. */
  PAYMENT_PROVIDER_RATE_LIMITED: 'PAYMENT_PROVIDER_RATE_LIMITED',
  /** Any other Stripe failure (authentication, API, connection). */
  PAYMENT_PROVIDER_ERROR: 'PAYMENT_PROVIDER_ERROR',
} as const;
```
  - `domains/billing/src/infrastructure/stripe/stripe.errors.ts`:

Old:
```ts
import Stripe from 'stripe';

/** Stable error codes emitted by `@platform/payments` (part of the public API — never rename). */
export const PaymentErrorCode = {
  INVALID_WEBHOOK_SIGNATURE: 'INVALID_WEBHOOK_SIGNATURE',
  INVALID_WEBHOOK_PAYLOAD: 'INVALID_WEBHOOK_PAYLOAD',
  PAYMENT_REQUEST_INVALID: 'PAYMENT_REQUEST_INVALID',
  PAYMENT_DECLINED: 'PAYMENT_DECLINED',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  PAYMENT_PROVIDER_RATE_LIMITED: 'PAYMENT_PROVIDER_RATE_LIMITED',
  PAYMENT_PROVIDER_ERROR: 'PAYMENT_PROVIDER_ERROR',
} as const;
export type PaymentErrorCode = (typeof PaymentErrorCode)[keyof typeof PaymentErrorCode];
```
New:
```ts
import Stripe from 'stripe';
import { BillingErrorCode } from '../../billing.constants.js';
```
    Then replace every `PaymentErrorCode.` with `BillingErrorCode.` (5 occurrences).
  - `domains/billing/src/infrastructure/stripe/stripe.types.ts`:
    - old: `export interface CreateCheckoutSessionInput {`
    - new: `export interface StripeCheckoutSessionInput {`
  - `domains/billing/src/infrastructure/stripe/stripe.service.ts`:

Old:
```ts
import Stripe from 'stripe';
import { InjectStripe, STRIPE_WEBHOOK_TOLERANCE_SEC } from './stripe.constants.js';
import { PaymentErrorCode, toPaymentDomainException } from './stripe.errors.js';
import type { CreateCheckoutSessionInput } from './stripe.types.js';
```
New:
```ts
import Stripe from 'stripe';
import { BillingErrorCode } from '../../billing.constants.js';
import { InjectStripe, STRIPE_WEBHOOK_TOLERANCE_SEC } from './stripe.constants.js';
import { toPaymentDomainException } from './stripe.errors.js';
import type { StripeCheckoutSessionInput } from './stripe.types.js';
```
    Change `    input: CreateCheckoutSessionInput,` to `    input: StripeCheckoutSessionInput,`, then
    replace every `PaymentErrorCode.` with `BillingErrorCode.` (3 occurrences).
  - `domains/billing/src/infrastructure/stripe/stripe.module.ts`:

Old:
```ts
/**
 * Global Stripe integration: `STRIPE_CLIENT` (raw SDK, `@InjectStripe()`) + `StripeService`.
 * Import once in the process that talks to Stripe (billing-service / monolith).
 */
```
New:
```ts
/**
 * Billing's Stripe adapter: `STRIPE_CLIENT` (raw SDK, `@InjectStripe()`) + `StripeService`.
 * Imported by `BillingCoreModule` only (its handlers are the one consumer), so no app imports it
 * and it is not global.
 */
```
    Delete the line `      global: true,`.

- [ ] **Step 5: Wire the adapter into the core and switch the importers.**
  - `domains/billing/src/billing-core.module.ts`:

Old:
```ts
import { PurgeStripeEventsCron } from './infrastructure/scheduling/purge-stripe-events.cron.js';
```
New:
```ts
import { PurgeStripeEventsCron } from './infrastructure/scheduling/purge-stripe-events.cron.js';
import { StripeModule } from './infrastructure/stripe/stripe.module.js';
```
Old:
```ts
 * `StripeModule.forRootAsync()`, `KafkaProducerModule.forRootAsync()`, `RedisModule.forRootAsync()`
 * (the purge cron's distributed lock) and — for the cron to be scheduled —
 * `ScheduleModule.forRoot()`.
 */
@Module({
  imports: [ConfigModule.forFeature(stripeConfig)],
```
New:
```ts
 * `KafkaProducerModule.forRootAsync()`, `RedisModule.forRootAsync()` (the purge cron's
 * distributed lock) and — for the cron to be scheduled — `ScheduleModule.forRoot()`. It imports
 * its own Stripe adapter (`StripeModule.forRootAsync()`), so no app imports Stripe.
 */
@Module({
  imports: [ConfigModule.forFeature(stripeConfig), StripeModule.forRootAsync()],
```
  - `domains/billing/src/index.ts`:

Old:
```ts
// Presentation
```
New:
```ts
// Stripe adapter (imported by BillingCoreModule; public for custom wiring / tests)
export * from './infrastructure/stripe/stripe.constants.js';
export * from './infrastructure/stripe/stripe.errors.js';
export * from './infrastructure/stripe/stripe.module.js';
export * from './infrastructure/stripe/stripe.service.js';
export type * from './infrastructure/stripe/stripe.types.js';
// Presentation
```
  - Replace each `@platform/payments` import:

| File | Old | New |
|---|---|---|
| `src/application/commands/create-checkout-session/create-checkout-session.handler.ts` | `import { StripeService } from '@platform/payments';` | `import { StripeService } from '../../../infrastructure/stripe/stripe.service.js';` |
| `src/application/commands/create-checkout-session/create-checkout-session.handler.spec.ts` | `import type { StripeService } from '@platform/payments';` | `import type { StripeService } from '../../../infrastructure/stripe/stripe.service.js';` |
| `src/application/commands/handle-stripe-webhook/handle-stripe-webhook.handler.ts` | `import { StripeService } from '@platform/payments';` | `import { StripeService } from '../../../infrastructure/stripe/stripe.service.js';` |
| `src/billing.modules.spec.ts` | `import { StripeService } from '@platform/payments';` | `import { StripeService } from './infrastructure/stripe/stripe.service.js';` |
| `test/stripe-webhook.flow.spec.ts` | `import { StripeService } from '@platform/payments';` | `import { StripeService } from '../src/infrastructure/stripe/stripe.service.js';` |
| `test/billing-test.utils.ts` | `import { createStripeClient, StripeService } from '@platform/payments';` | `import { createStripeClient } from '../src/infrastructure/stripe/stripe.module.js';` + `import { StripeService } from '../src/infrastructure/stripe/stripe.service.js';` |

  (all under `domains/billing/`). Then run `npx biome check --write domains/billing`.

- [ ] **Step 6: Apps stop importing Stripe; drop the package from the manifests.**
  - `apps/monolith/src/app.module.ts`: delete `import { StripeModule } from '@platform/payments';` and the line
    `    StripeModule.forRootAsync(),`.
  - `apps/billing-service/src/app.module.ts`: delete the line `import { StripeModule } from '@platform/payments';`.

Old:
```ts
    // The Stripe client (secret key, retries, timeout) + webhook signature verification.
    StripeModule.forRootAsync(),
    BillingGrpcModule,
```
New:
```ts
    // The core (handlers, repositories, its own Stripe adapter) + billing.v1.BillingService.
    BillingGrpcModule,
```
  - Delete `"@platform/payments": "workspace:*",` from `apps/monolith/package.json`,
    `apps/billing-service/package.json` and `domains/billing/package.json`. Then run `bun install`.

- [ ] **Step 7: Run the tests.**
  - `npx vitest run --project billing --project billing-service --project billing-service:e2e --project monolith:e2e`.
    Expected: PASS. This includes:
    - the moved `infrastructure/stripe/*.spec.ts`;
    - the billing-service e2e `HandleStripeWebhook verifies the signature…`;
    - the monolith e2e `unsigned Stripe webhook → 422 INVALID_WEBHOOK_SIGNATURE`.
  - `git grep -n -E "@platform/payments|PaymentErrorCode|libs/payments" -- ':!docs/superpowers' ':!*.md'` must print nothing.

- [ ] **Step 8: Update the docs.**
  - `domains/billing/README.md`:
    - In the source tree, change `local + gRPC port adapters` to `local + gRPC port adapters, the Stripe adapter (stripe/)`.
    - Modules table, `BillingCoreModule` row:
      - old cell: `CQRS handlers, \`PaymentSucceededRelay\`, Drizzle repositories`
      - new cell: `CQRS handlers, \`PaymentSucceededRelay\`, Drizzle repositories, the Stripe adapter (\`StripeModule.forRootAsync()\`)`
    - In the billing-service code sample, delete the line `    StripeModule.forRootAsync(),`.
    - In the monolith comment, change `KafkaProducerModule, StripeModule, AuthModule` to `KafkaProducerModule, AuthModule`.
    - Old:
      ```md
      `BillingCoreModule` expects the global `CqrsModule.forRoot()`, `DatabaseModule` (DRIZZLE + `@Transactional()`),
      `StripeModule` and `KafkaProducerModule`; it loads the `stripe` config namespace itself.
      ```
      New:
      ```md
      `BillingCoreModule` expects the global `CqrsModule.forRoot()`, `DatabaseModule` (DRIZZLE + `@Transactional()`)
      and `KafkaProducerModule`. It imports its own Stripe adapter (`StripeModule.forRootAsync()`, below) and loads the
      `stripe` config namespace itself, so no app imports Stripe.
      ```
    - After the REST errors paragraph, which ends `…documented in OpenAPI from the same zod schemas.`, add:
      `` Every billing code, the Stripe adapter's included, is a `BillingErrorCode` value.``
    - Insert this section immediately above `## Flows`:
      ```md
      ## Stripe adapter (`infrastructure/stripe`)

      One process-wide Stripe client, a small typed facade (`StripeService`) for idempotent Checkout Sessions and
      webhook signature verification, and a mapper that turns Stripe SDK errors into `DomainException`s, so the
      handlers never see `Stripe.errors.*`. (It used to be the `@platform/payments` package.)

      | Export                                                          | Kind              | Purpose                                                                                                     |
      | --------------------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------- |
      | `StripeModule.forRootAsync(): DynamicModule`                    | module            | `STRIPE_CLIENT` + `StripeService` from the `stripe` namespace. Imported by `BillingCoreModule` (not global). |
      | `StripeService`                                                 | provider          | `createCheckoutSession(input, idempotencyKey?)`, `constructWebhookEvent(payload, signature)`, `client`.     |
      | `createStripeClient(cfg: StripeConfig): Stripe`                 | function          | Builds the SDK client (used by the module and by tests).                                                    |
      | `STRIPE_CLIENT` / `InjectStripe()`                              | token / decorator | Raw `Stripe` instance for calls the facade doesn't wrap.                                                    |
      | `StripeCheckoutSessionInput`                                    | type              | `{ customerEmail, priceId, quantity, successUrl, cancelUrl, clientReferenceId, metadata }`.                 |
      | `toPaymentDomainException(error): DomainException \| undefined` | function          | Stripe SDK error → `DomainException` (`undefined` for non-Stripe values).                                   |
      | `STRIPE_WEBHOOK_TOLERANCE_SEC` (300), `STRIPE_APP_INFO`         | constants         | Replay window for webhook timestamps; app info sent to Stripe.                                              |

      | Stripe error                | DomainException                                               | `BillingErrorCode`              |
      | --------------------------- | ------------------------------------------------------------- | ------------------------------- |
      | `StripeIdempotencyError`    | `DomainConflictException` (409)                               | `IDEMPOTENCY_KEY_REUSED`        |
      | `StripeCardError`           | `BusinessRuleViolationException` (422, `details.declineCode`) | `PAYMENT_DECLINED`              |
      | `StripeInvalidRequestError` | `DomainValidationException` (422, issue at `param`)           | `PAYMENT_REQUEST_INVALID`       |
      | `StripeRateLimitError`      | `ServiceUnavailableException` (503)                           | `PAYMENT_PROVIDER_RATE_LIMITED` |
      | anything else from Stripe   | `ExternalServiceException` (502, generic message)             | `PAYMENT_PROVIDER_ERROR`        |

      `details.stripeRequestId` is attached when Stripe returned one. Webhook verification fails with 422
      `INVALID_WEBHOOK_SIGNATURE` (missing, forged or stale signature) or `INVALID_WEBHOOK_PAYLOAD` (signed but not JSON).

      - `apiVersion` is left out on purpose: the SDK types it as its pinned literal, so the API version moves with SDK
        upgrades. Pin the webhook endpoint in the dashboard to the same version.
      - `constructWebhookEvent` is synchronous on purpose (node:crypto HMAC is the cheapest path).
      - The SDK keeps connections alive and retries 409/429/5xx/network errors, adding idempotency keys to retried
        POSTs; the handlers still pass their own business key (`checkout-<paymentId>`).
      - Tests sign payloads with `Stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp? })`.
      ```
    - In Tests, after the `Drizzle repositories` bullet, add:
      ``- `infrastructure/stripe/*.spec.ts` — the Stripe adapter: SDK error mapping, signature verification (valid, forged, stale, re-serialised, missing, not JSON), Checkout params and idempotency key, module wiring and the invalid-key boot failure.``
  - `apps/billing-service/README.md`:
    - Delete the table row that starts with ``| `StripeModule.forRootAsync()` ``.
    - In the `BillingGrpcModule` row, change ``| `BillingCoreModule` + `BillingGrpcController` `` to
      ``| `BillingCoreModule` (with its Stripe adapter: client, retries, timeout, webhook signature verification) + `BillingGrpcController` ``.
  - `apps/monolith/README.md`: change `queue/mailer/Kafka/Stripe/storage` to `queue/mailer/Kafka/storage`.
  - `docs/ARCHITECTURE.md`:
    - In the platform-libs row, change `` `libs/mailer`, `libs/payments`, `libs/storage` `` to `` `libs/mailer`, `libs/storage` ``.
    - Change `` `HandleStripeWebhookHandler` injects `StripeService` (`@platform/payments`) `` to
      `` `HandleStripeWebhookHandler` injects billing's own `StripeService` (`infrastructure/stripe`) ``.
    - Delete the composition-matrix row that starts with ``| `StripeModule.forRootAsync()` ``.
  - `docs/API.md`, Domain codes table, `INVALID_WEBHOOK_SIGNATURE` row:
    - old source cell: `` `@platform/payments` (Stripe). It also defines `PAYMENT_DECLINED`, `PAYMENT_PROVIDER_ERROR` and others (`PaymentErrorCode`) ``
    - new source cell: `` billing's Stripe adapter. Also `INVALID_WEBHOOK_PAYLOAD`, `PAYMENT_REQUEST_INVALID`, `PAYMENT_DECLINED`, `PAYMENT_PROVIDER_RATE_LIMITED`, `PAYMENT_PROVIDER_ERROR` (`BillingErrorCode`) ``
  - `README.md`:
    - Stripe row: change `` `libs/payments` (`stripe.service.ts`), `domains/billing` (checkout sessions, `` to
      `` `domains/billing` (Stripe adapter in `src/infrastructure/stripe`, checkout sessions, ``.
    - Delete `[payments](libs/payments/README.md), ` from the infrastructure-libs list.
  - `docs/RELEASING.md`: change `` `observability`, `payments`, `redis` `` to `` `observability`, `redis` ``.
  - Run `npx prettier --write domains/billing/README.md apps/billing-service/README.md apps/monolith/README.md docs/ARCHITECTURE.md docs/API.md README.md docs/RELEASING.md`.

- [ ] **Step 9: Full check and build.** `bun run check`, then `bun run build`. Expected: both PASS. No
  `payments` project or package remains (`ls libs` has no `payments`).

- [ ] **Step 10: Commit.**
```bash
git add domains/billing/src/infrastructure/stripe domains/billing/src/billing.constants.ts \
  domains/billing/src/billing.constants.spec.ts domains/billing/src/billing-core.module.ts domains/billing/src/index.ts \
  domains/billing/src/billing.modules.spec.ts \
  domains/billing/src/application/commands/create-checkout-session/create-checkout-session.handler.ts \
  domains/billing/src/application/commands/create-checkout-session/create-checkout-session.handler.spec.ts \
  domains/billing/src/application/commands/handle-stripe-webhook/handle-stripe-webhook.handler.ts \
  domains/billing/test/billing-test.utils.ts domains/billing/test/stripe-webhook.flow.spec.ts \
  domains/billing/package.json apps/monolith/package.json apps/billing-service/package.json bun.lock \
  apps/monolith/src/app.module.ts apps/billing-service/src/app.module.ts \
  domains/billing/README.md apps/billing-service/README.md apps/monolith/README.md docs/ARCHITECTURE.md \
  docs/API.md README.md docs/RELEASING.md
git commit -m "refactor(billing,monolith,billing-service): fold @platform/payments into billing's Stripe adapter" -m "libs/payments moves to domains/billing/src/infrastructure/stripe and the package is deleted.
BillingCoreModule imports StripeModule.forRootAsync() (no longer global), so the monolith and
billing-service stop importing it. The facade input type becomes StripeCheckoutSessionInput and
PaymentErrorCode merges into BillingErrorCode with unchanged string values." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
(`git mv` and `git rm -r libs/payments` already staged the moves and deletions.)

---

### Task billing-3: Move the stripe config namespace into billing

**Files:**
- Move: `libs/config/src/namespaces/stripe.config.ts` -> `domains/billing/src/infrastructure/stripe/stripe.config.ts` (the version with D's production guards)
- Create: `domains/billing/src/infrastructure/stripe/stripe.config.spec.ts`
- Modify: `libs/config/src/index.ts:12,25` (export the production-guard helpers; drop the stripe export)
- Modify: `libs/config/src/all-config.ts:19,37,59` (only the `stripe` lines)
- Modify: `libs/config/src/namespaces/namespaces.spec.ts:21-25,40,135-138,250,337-356` (only the stripe parts)
- Modify: `libs/config/src/namespaces/production-guards.spec.ts:12,85-133` (D's file; only the stripe parts)
- Modify: `domains/billing/src/infrastructure/stripe/stripe.module.ts:3`, `stripe.service.ts:3`, `stripe.service.spec.ts:2`
- Modify: `domains/billing/src/application/commands/create-checkout-session/create-checkout-session.handler.ts:4`, `domains/billing/src/billing-core.module.ts:3`, `domains/billing/test/billing-test.utils.ts:7`, `domains/billing/src/index.ts`
- Modify: `apps/billing-service/test/env-example.spec.ts:4,15-17`
- Modify (docs): `libs/config/README.md:45`, `docs/CONFIGURATION.md:366`, `domains/billing/README.md:211`
- Test: `domains/billing/src/infrastructure/stripe/stripe.config.spec.ts`, `libs/config/src/namespaces/namespaces.spec.ts`, `apps/billing-service/test/env-example.spec.ts`

**Interfaces:**
- Consumes:
  - from the platform lane, `validateAllEnv(env, extraNamespaces = [])` and `scripts/check-env-example.mjs` scanning `domains/**/src/**/*.config.ts`;
  - D's `libs/config/src/env/production-guards.ts` (`isKnownLocalSecret`, `isLoopbackHost`, `parseUrl`);
  - billing-2's `domains/billing/src/infrastructure/stripe/`.
- Produces:
  - `domains/billing/src/infrastructure/stripe/stripe.config.ts`, re-exported by `@domain/billing`:
    - `stripeConfig`, created with `defineConfigNamespace('stripe', stripeEnvSchema)` (token `CONFIGURATION(stripe)`);
    - `type StripeConfig`;
    - `stripeEnvSchema`;
    - `PLACEHOLDER_STRIPE_SECRET_KEY` and `PLACEHOLDER_STRIPE_WEBHOOK_SECRET`.
  - Env names are unchanged.
  - `@platform/config` no longer exports these and `CONFIG_NAMESPACES` has no `stripe` key.
  - `@platform/config` now exports D's production-guard helpers.

- [ ] **Step 1: Write the failing tests.**
  - Create `domains/billing/src/infrastructure/stripe/stripe.config.spec.ts`. It holds every stripe test
    that lives in libs/config today. Source of truth: D's committed versions of the blocks below. If
    D changed them after this plan was written, paste D's blocks verbatim:
```ts
import { EnvValidationError } from '@platform/config';
import { describe, expect, it } from 'vitest';
import {
  PLACEHOLDER_STRIPE_SECRET_KEY,
  PLACEHOLDER_STRIPE_WEBHOOK_SECRET,
  stripeConfig,
} from './stripe.config.js';

const PROD = { NODE_ENV: 'production' } as const;

const errorOf = (fn: () => unknown): EnvValidationError => {
  try {
    fn();
  } catch (error) {
    if (error instanceof EnvValidationError) return error;
    throw error;
  }
  throw new Error('expected an EnvValidationError');
};

describe('stripe namespace (owned by billing)', () => {
  it('works with an empty environment (dev placeholders)', () => {
    expect(stripeConfig.parse({})).toMatchObject({
      secretKey: 'sk_test_placeholder',
      maxNetworkRetries: 2,
    });
  });

  it('keeps its Nest config token', () => {
    expect(stripeConfig.KEY).toBe('CONFIGURATION(stripe)');
  });

  it('names the env var of an invalid value', () => {
    const error = errorOf(() => stripeConfig.parse({ STRIPE_WEBHOOK_SECRET: 'nope' }));
    expect(error.namespace).toBe('stripe');
    expect(error.message).toContain('Invalid environment for "stripe"');
    expect(error.message).toContain('→ at STRIPE_WEBHOOK_SECRET');
  });
});

describe('stripe production placeholder guard', () => {
  it('rejects the development placeholders in production (forged webhooks would verify)', () => {
    const error = errorOf(() => stripeConfig.parse({ NODE_ENV: 'production' }));
    expect(error.message).toContain('→ at STRIPE_SECRET_KEY');
    expect(error.message).toContain('→ at STRIPE_WEBHOOK_SECRET');
  });

  it('accepts real values in production and the placeholders elsewhere', () => {
    expect(
      stripeConfig.parse({
        NODE_ENV: 'production',
        STRIPE_SECRET_KEY: 'sk_live_51Hx',
        STRIPE_WEBHOOK_SECRET: 'whsec_1a2b3c',
        STRIPE_SUCCESS_URL: 'https://app.example.com/billing/success',
        STRIPE_CANCEL_URL: 'https://app.example.com/billing/cancel',
      }).webhookSecret,
    ).toBe('whsec_1a2b3c');
    expect(stripeConfig.parse({ NODE_ENV: 'test' }).secretKey).toBe(PLACEHOLDER_STRIPE_SECRET_KEY);
    expect(stripeConfig.parse({}).webhookSecret).toBe(PLACEHOLDER_STRIPE_WEBHOOK_SECRET);
  });
});

describe('stripe: known local secrets and redirect URLs', () => {
  const COMPOSE = {
    STRIPE_SECRET_KEY: 'sk_test_compose_local_not_for_production',
    STRIPE_WEBHOOK_SECRET: 'whsec_compose_local_not_for_production',
  } as const;
  const REAL = {
    STRIPE_SECRET_KEY: 'sk_live_51HxRealKey',
    STRIPE_WEBHOOK_SECRET: 'whsec_1a2b3c',
    STRIPE_SUCCESS_URL: 'https://app.example.com/billing/success',
    STRIPE_CANCEL_URL: 'https://app.example.com/billing/cancel',
  };

  it('rejects the compose fallback keys in production unless ALLOW_KNOWN_LOCAL_SECRETS', () => {
    const env = {
      ...PROD,
      ...REAL,
      STRIPE_SECRET_KEY: COMPOSE.STRIPE_SECRET_KEY,
      STRIPE_WEBHOOK_SECRET: COMPOSE.STRIPE_WEBHOOK_SECRET,
    };
    const error = errorOf(() => stripeConfig.parse(env));
    expect(error.message).toContain('→ at STRIPE_SECRET_KEY');
    expect(error.message).toContain('→ at STRIPE_WEBHOOK_SECRET');
    expect(stripeConfig.parse({ ...env, ALLOW_KNOWN_LOCAL_SECRETS: 'true' }).secretKey).toBe(
      COMPOSE.STRIPE_SECRET_KEY,
    );
  });

  it('requires https, non-loopback Checkout redirect URLs in production', () => {
    const local = errorOf(() =>
      stripeConfig.parse({
        ...PROD,
        STRIPE_SECRET_KEY: REAL.STRIPE_SECRET_KEY,
        STRIPE_WEBHOOK_SECRET: REAL.STRIPE_WEBHOOK_SECRET,
      }),
    );
    expect(local.message).toContain('→ at STRIPE_SUCCESS_URL');
    expect(local.message).toContain('→ at STRIPE_CANCEL_URL');
    expect(local.message).toContain('STRIPE_ALLOW_LOCAL_REDIRECTS');
    const plainHttp = errorOf(() =>
      stripeConfig.parse({ ...PROD, ...REAL, STRIPE_SUCCESS_URL: 'http://app.example.com/ok' }),
    );
    expect(plainHttp.message).toContain('→ at STRIPE_SUCCESS_URL');
    expect(stripeConfig.parse({ ...PROD, ...REAL }).successUrl).toBe(REAL.STRIPE_SUCCESS_URL);
    expect(
      stripeConfig.parse({
        ...PROD,
        STRIPE_SECRET_KEY: REAL.STRIPE_SECRET_KEY,
        STRIPE_WEBHOOK_SECRET: REAL.STRIPE_WEBHOOK_SECRET,
        STRIPE_ALLOW_LOCAL_REDIRECTS: 'true',
      }).cancelUrl,
    ).toBe('http://localhost:3000/billing/cancel');
  });
});
```
  - In `libs/config/src/namespaces/namespaces.spec.ts`, inside
    `describe('config namespaces — defaults work with an EMPTY environment…')`, right after the
    `it('every namespace parses {}', …)` block, add:
```ts
  it('holds no domain namespace (stripe belongs to @domain/billing)', () => {
    expect(CONFIG_NAMESPACES).not.toHaveProperty('stripe');
  });
```

- [ ] **Step 2: Run them.** `npx vitest run --project billing --project config stripe.config.spec namespaces.spec`. Expected: FAIL.
  - `stripe.config.spec.ts` fails to load: `Failed to load url ./stripe.config.js`.
  - `namespaces.spec.ts > holds no domain namespace…` fails: `expected { …, stripe: … } to not have property "stripe"`.

- [ ] **Step 3: Move the namespace and make its imports package imports.**
```bash
git mv libs/config/src/namespaces/stripe.config.ts domains/billing/src/infrastructure/stripe/stripe.config.ts
```
  In the moved file, replace every relative `../…` import with one `@platform/config` import of the
  same names. With D's version:

Old:
```ts
import type { ConfigType } from '@nestjs/config';
import { z } from 'zod';
import { defineConfigNamespace } from '../define-config-namespace.js';
import { zBool, zInt, zNodeEnv, zStr, zUrl } from '../env/env.helpers.js';
import { isKnownLocalSecret, isLoopbackHost, parseUrl } from '../env/production-guards.js';
```
New:
```ts
import type { ConfigType } from '@nestjs/config';
import {
  defineConfigNamespace,
  isKnownLocalSecret,
  isLoopbackHost,
  parseUrl,
  zBool,
  zInt,
  zNodeEnv,
  zStr,
  zUrl,
} from '@platform/config';
import { z } from 'zod';
```
  `grep -n "from '\.\./" domains/billing/src/infrastructure/stripe/stripe.config.ts` must print nothing.
  In `libs/config/src/index.ts`:
  - Old: `export * from './env/parse-env.js';`
  - New: `export * from './env/parse-env.js';` followed by `export * from './env/production-guards.js';`.
    Skip the added line if `git grep -n production-guards libs/config/src/index.ts` already prints it.
    If D named the helpers' module differently, export that module.
  - Delete `export * from './namespaces/stripe.config.js';`.

- [ ] **Step 4: Take stripe out of the platform aggregator and its specs.**
  - `libs/config/src/all-config.ts` (match on text, since the platform lane reshaped this file):
    - delete `import { type StripeConfig, stripeConfig } from './namespaces/stripe.config.js';`;
    - delete the `  stripe: stripeConfig,` entry of `CONFIG_NAMESPACES`;
    - delete the `  stripe: StripeConfig;` member of the parsed-config interface (`AllConfig` today).
  - `libs/config/src/namespaces/namespaces.spec.ts`:
    - delete the `import { PLACEHOLDER_STRIPE_SECRET_KEY, PLACEHOLDER_STRIPE_WEBHOOK_SECRET, stripeConfig } from './stripe.config.js';` block;
    - delete the `expect(stripeConfig.parse({})).toMatchObject({ secretKey: 'sk_test_placeholder', maxNetworkRetries: 2 });` statement;
    - delete the `[stripeConfig, { STRIPE_WEBHOOK_SECRET: 'nope' }, 'STRIPE_WEBHOOK_SECRET'],` table row;
    - delete the whole `describe('stripe production placeholder guard', …)` block;
    - remove `'stripe'` from any namespace-name list the platform lane added.
  - `libs/config/src/namespaces/production-guards.spec.ts` (D's file):
    - delete `import { stripeConfig } from './stripe.config.js';`;
    - delete the whole `describe('stripe: known local secrets and redirect URLs', …)` block.
    - The `COMPOSE.STRIPE_*` strings stay: the helper test still checks them as known local secrets.
  - `grep -n -i "stripeConfig\|stripe.config" libs/config/src` must print nothing.

- [ ] **Step 5: Point billing at its own namespace.**

| File (under `domains/billing/`) | Old | New |
|---|---|---|
| `src/infrastructure/stripe/stripe.module.ts` | `import { type StripeConfig, stripeConfig } from '@platform/config';` | `import { type StripeConfig, stripeConfig } from './stripe.config.js';` |
| `src/infrastructure/stripe/stripe.service.ts` | `import { type StripeConfig, stripeConfig } from '@platform/config';` | `import { type StripeConfig, stripeConfig } from './stripe.config.js';` |
| `src/infrastructure/stripe/stripe.service.spec.ts` | `import { stripeConfig } from '@platform/config';` | `import { stripeConfig } from './stripe.config.js';` |
| `src/application/commands/create-checkout-session/create-checkout-session.handler.ts` | `import { type StripeConfig, stripeConfig } from '@platform/config';` | `import { type StripeConfig, stripeConfig } from '../../../infrastructure/stripe/stripe.config.js';` |
| `src/billing-core.module.ts` | `import { stripeConfig } from '@platform/config';` | `import { stripeConfig } from './infrastructure/stripe/stripe.config.js';` |
| `test/billing-test.utils.ts` | `import { stripeConfig } from '@platform/config';` | `import { stripeConfig } from '../src/infrastructure/stripe/stripe.config.js';` |

  - `domains/billing/src/index.ts`:
    - old: `export * from './infrastructure/stripe/stripe.constants.js';`
    - new: `export * from './infrastructure/stripe/stripe.config.js';` followed by `export * from './infrastructure/stripe/stripe.constants.js';`.
  - `apps/billing-service/test/env-example.spec.ts`:
    - after `import { parseEnv } from 'node:util';`, add `import { stripeConfig } from '@domain/billing';`;
    - old:
      ```ts
        it('passes every config namespace', () => {
          expect(() => validateAllEnv(env)).not.toThrow();
        });
      ```
      new:
      ```ts
        it('passes every config namespace this service loads (stripe is billing-owned)', () => {
          expect(() => validateAllEnv(env, [stripeConfig])).not.toThrow();
        });
      ```
    - leave the second `validateAllEnv(env)` call, in the `pins the service identity…` test, unchanged:
      it only reads platform namespaces.
  - Run `npx biome check --write domains/billing libs/config/src apps/billing-service/test`.

- [ ] **Step 6: Run the tests.**
  - `npx vitest run --project config --project billing --project billing-service --project billing-service:e2e --project monolith:e2e`.
    Expected: PASS.
  - `node scripts/check-env-example.mjs`. Expected: `.env.example documents all … variables` (exit 0).
    `STRIPE_*`, `STRIPE_ALLOW_LOCAL_REDIRECTS` and `ALLOW_KNOWN_LOCAL_SECRETS` are found in the domain file.

- [ ] **Step 7: Update the docs.**
  - `libs/config/README.md`: delete the table row that starts with ``| `stripe` ``.
  - `docs/CONFIGURATION.md`, `### \`stripe\` — Checkout + webhooks` section:
    - old: `[\`stripe.config.ts\`](../libs/config/src/namespaces/stripe.config.ts) · monolith, billing-service`
    - new: `[\`stripe.config.ts\`](../domains/billing/src/infrastructure/stripe/stripe.config.ts) (owned by billing) · monolith, billing-service`
  - `domains/billing/README.md`, Configuration: change `` `stripe` namespace: `` to
    `` `stripe` namespace (`src/infrastructure/stripe/stripe.config.ts`, owned by billing; production rejects the dev placeholders, the compose fallbacks and local redirect URLs): ``.
  - Run `npx prettier --write libs/config/README.md docs/CONFIGURATION.md domains/billing/README.md`, then `bun run check`.
    Expected: PASS.

- [ ] **Step 8: Commit.**
```bash
git add domains/billing/src/infrastructure/stripe/stripe.config.ts domains/billing/src/infrastructure/stripe/stripe.config.spec.ts \
  domains/billing/src/infrastructure/stripe/stripe.module.ts domains/billing/src/infrastructure/stripe/stripe.service.ts \
  domains/billing/src/infrastructure/stripe/stripe.service.spec.ts \
  domains/billing/src/application/commands/create-checkout-session/create-checkout-session.handler.ts \
  domains/billing/src/billing-core.module.ts domains/billing/src/index.ts domains/billing/test/billing-test.utils.ts \
  libs/config/src/index.ts libs/config/src/all-config.ts libs/config/src/namespaces/namespaces.spec.ts \
  libs/config/src/namespaces/production-guards.spec.ts apps/billing-service/test/env-example.spec.ts \
  libs/config/README.md docs/CONFIGURATION.md domains/billing/README.md
git commit -m "refactor(billing,config): move the stripe config namespace into billing" -m "stripe.config.ts (with its production guards) moves next to the Stripe adapter. @platform/config
drops it from CONFIG_NAMESPACES and its barrel, and exports the production-guard helpers the
namespace uses. Env names are unchanged; billing-service's .env.example spec passes stripeConfig
to validateAllEnv." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task billing-4: STRIPE_SIGNATURE header name into billing

**Files:**
- Create: `libs/common/src/constants/headers.constants.spec.ts`
- Modify: `libs/common/src/constants/headers.constants.ts:9`
- Modify: `domains/billing/src/billing.constants.ts` (append), `domains/billing/src/billing.constants.spec.ts` (append)
- Modify: `domains/billing/src/presentation/http/billing.controller.ts:31,33,116`
- Test: `libs/common/src/constants/headers.constants.spec.ts`, `domains/billing/src/billing.constants.spec.ts`, `domains/billing/src/presentation/http/billing.controller.spec.ts`

**Interfaces:**
- Consumes: `billing.constants.spec.ts` from billing-2.
- Produces: `STRIPE_SIGNATURE_HEADER = 'stripe-signature'`, exported from `domains/billing/src/billing.constants.ts` and from `@domain/billing`. `HTTP_HEADERS` (`@platform/common`) no longer has `STRIPE_SIGNATURE`.

- [ ] **Step 1: Write the failing tests.** Create `libs/common/src/constants/headers.constants.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { HTTP_HEADERS } from './headers.constants.js';

describe('HTTP_HEADERS', () => {
  it('names platform-wide headers only (a domain keeps its own, e.g. billing’s Stripe-Signature)', () => {
    expect(HTTP_HEADERS).not.toHaveProperty('STRIPE_SIGNATURE');
    expect(HTTP_HEADERS).toMatchObject({
      REQUEST_ID: 'x-request-id',
      CORRELATION_ID: 'x-correlation-id',
      IDEMPOTENCY_KEY: 'idempotency-key',
      RETRY_AFTER: 'retry-after',
    });
  });
});
```
  In `domains/billing/src/billing.constants.spec.ts`:
  - change the import to `import { BillingErrorCode, STRIPE_SIGNATURE_HEADER } from './billing.constants.js';`;
  - append:
```ts

describe('STRIPE_SIGNATURE_HEADER', () => {
  it('is the lower-case header Stripe signs webhooks with (Node lower-cases incoming names)', () => {
    expect(STRIPE_SIGNATURE_HEADER).toBe('stripe-signature');
  });
});
```

- [ ] **Step 2: Run them.** `npx vitest run --project common --project billing headers.constants.spec billing.constants.spec`. Expected: FAIL.
  - `HTTP_HEADERS > names platform-wide headers only…` fails: `expected { …(5) } to not have property "STRIPE_SIGNATURE"`.
  - `STRIPE_SIGNATURE_HEADER > …` fails: `expected undefined to be 'stripe-signature'`.

- [ ] **Step 3: Move the constant.**
  - `libs/common/src/constants/headers.constants.ts`: delete the line `  STRIPE_SIGNATURE: 'stripe-signature',`.
  - `domains/billing/src/billing.constants.ts`: append:
```ts

/** Header carrying Stripe's webhook signature (lower-case: Node lower-cases incoming header names). */
export const STRIPE_SIGNATURE_HEADER = 'stripe-signature';
```
  - `domains/billing/src/presentation/http/billing.controller.ts`:
    - change `import { HTTP_HEADERS, Public } from '@platform/common';` to `import { Public } from '@platform/common';`;
    - change `import { BILLING_LIMITS } from '../../billing.constants.js';` to `import { BILLING_LIMITS, STRIPE_SIGNATURE_HEADER } from '../../billing.constants.js';`;
    - change `    @HeaderValue(HTTP_HEADERS.STRIPE_SIGNATURE) signature: string | undefined,` to
      `    @HeaderValue(STRIPE_SIGNATURE_HEADER) signature: string | undefined,`.

- [ ] **Step 4: Run the tests.** `npx vitest run --project common --project billing` (including
  `billing.controller.spec.ts > … hands the exact request bytes and the signature to the port`) and
  `npx vitest run --project monolith:e2e`. Expected: PASS. Then `bun run check`. Expected: PASS.

- [ ] **Step 5: Commit.**
```bash
git add libs/common/src/constants/headers.constants.ts libs/common/src/constants/headers.constants.spec.ts \
  domains/billing/src/billing.constants.ts domains/billing/src/billing.constants.spec.ts \
  domains/billing/src/presentation/http/billing.controller.ts
git commit -m "refactor(billing,common): move the Stripe-Signature header name into billing" -m "HTTP_HEADERS keeps the platform-wide headers only; billing owns STRIPE_SIGNATURE_HEADER
('stripe-signature'), read by the webhook route." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task billing-5: Per-domain gRPC client target namespaces

**Files:**
- Create: `domains/identity/src/infrastructure/adapters/grpc/identity-grpc-client.config.ts` (+ `identity-grpc-client.config.spec.ts`)
- Create: `domains/notifications/src/infrastructure/adapters/grpc/notifications-grpc-client.config.ts` (+ `notifications-grpc-client.config.spec.ts`)
- Create: `domains/billing/src/infrastructure/adapters/grpc/billing-grpc-client.config.ts` (+ `billing-grpc-client.config.spec.ts`)
- Modify: `domains/identity/src/index.ts:67`, `domains/notifications/src/index.ts:26`, `domains/billing/src/index.ts:28`
- Test: the three `*-grpc-client.config.spec.ts`

**Interfaces:**
- Consumes: `defineConfigNamespace` and `zStr` from `@platform/config`, both unchanged.
- Produces, one namespace per domain, each typed `{ url: string }`:

| Export | Namespace (token) | Env var | Default | Type export |
|---|---|---|---|---|
| `identityGrpcClientConfig` | `identityGrpcClient` (`CONFIGURATION(identityGrpcClient)`) | `IDENTITY_GRPC_URL` | `localhost:50051` | `IdentityGrpcClientConfig` |
| `notificationsGrpcClientConfig` | `notificationsGrpcClient` | `NOTIFICATIONS_GRPC_URL` | `localhost:50052` | `NotificationsGrpcClientConfig` |
| `billingGrpcClientConfig` | `billingGrpcClient` | `BILLING_GRPC_URL` | `localhost:50053` | `BillingGrpcClientConfig` |

  - Each module also exports its env schema: `identityGrpcClientEnvSchema`, `notificationsGrpcClientEnvSchema`, `billingGrpcClientEnvSchema`.
  - Each config is exported from its domain barrel.
  - The transport/contracts lane uses them in `XApiModule.forRemote()` as `url: <x>GrpcClientConfig.parse().url`.

- [ ] **Step 1: Write the three failing specs.** Create `domains/billing/src/infrastructure/adapters/grpc/billing-grpc-client.config.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { billingGrpcClientConfig } from './billing-grpc-client.config.js';

describe('billingGrpcClientConfig (BILLING_GRPC_URL, read by BillingApiModule.forRemote())', () => {
  it('defaults to billing-service on its host-dev port', () => {
    expect(billingGrpcClientConfig.parse({})).toEqual({ url: 'localhost:50053' });
  });

  it('accepts any grpc-js target syntax and treats a blank value as unset', () => {
    expect(
      billingGrpcClientConfig.parse({ BILLING_GRPC_URL: 'dns:///billing-service:50051' }).url,
    ).toBe('dns:///billing-service:50051');
    expect(billingGrpcClientConfig.parse({ BILLING_GRPC_URL: '  ' }).url).toBe('localhost:50053');
  });

  it('is its own namespace, owned by billing', () => {
    expect(billingGrpcClientConfig.KEY).toBe('CONFIGURATION(billingGrpcClient)');
  });
});
```
Create `domains/identity/src/infrastructure/adapters/grpc/identity-grpc-client.config.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { identityGrpcClientConfig } from './identity-grpc-client.config.js';

describe('identityGrpcClientConfig (IDENTITY_GRPC_URL, read by IdentityApiModule.forRemote())', () => {
  it('defaults to identity-service on its host-dev port', () => {
    expect(identityGrpcClientConfig.parse({})).toEqual({ url: 'localhost:50051' });
  });

  it('accepts any grpc-js target syntax and treats a blank value as unset', () => {
    expect(
      identityGrpcClientConfig.parse({ IDENTITY_GRPC_URL: 'dns:///identity-service:50051' }).url,
    ).toBe('dns:///identity-service:50051');
    expect(identityGrpcClientConfig.parse({ IDENTITY_GRPC_URL: '  ' }).url).toBe('localhost:50051');
  });

  it('is its own namespace, owned by identity', () => {
    expect(identityGrpcClientConfig.KEY).toBe('CONFIGURATION(identityGrpcClient)');
  });
});
```
Create `domains/notifications/src/infrastructure/adapters/grpc/notifications-grpc-client.config.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { notificationsGrpcClientConfig } from './notifications-grpc-client.config.js';

describe('notificationsGrpcClientConfig (NOTIFICATIONS_GRPC_URL, read by NotificationsApiModule.forRemote())', () => {
  it('defaults to notifications-service on its host-dev port', () => {
    expect(notificationsGrpcClientConfig.parse({})).toEqual({ url: 'localhost:50052' });
  });

  it('accepts any grpc-js target syntax and treats a blank value as unset', () => {
    expect(
      notificationsGrpcClientConfig.parse({
        NOTIFICATIONS_GRPC_URL: 'dns:///notifications-service:50051',
      }).url,
    ).toBe('dns:///notifications-service:50051');
    expect(notificationsGrpcClientConfig.parse({ NOTIFICATIONS_GRPC_URL: '  ' }).url).toBe(
      'localhost:50052',
    );
  });

  it('is its own namespace, owned by notifications', () => {
    expect(notificationsGrpcClientConfig.KEY).toBe('CONFIGURATION(notificationsGrpcClient)');
  });
});
```

- [ ] **Step 2: Run them.** `npx vitest run --project billing --project identity --project notifications grpc-client.config.spec`. Expected:
  FAIL. All three fail to load with `Failed to load url ./<domain>-grpc-client.config.js`.

- [ ] **Step 3: Create the three namespaces.** Create `domains/billing/src/infrastructure/adapters/grpc/billing-grpc-client.config.ts`:
```ts
import type { ConfigType } from '@nestjs/config';
import { defineConfigNamespace, zStr } from '@platform/config';
import { z } from 'zod';

export const billingGrpcClientEnvSchema = z
  .object({
    // Any grpc-js target syntax: host:port, dns:///svc:port, … (compose: billing-service:50051).
    BILLING_GRPC_URL: zStr('localhost:50053'),
  })
  .transform((env) => ({
    /** Target of `billing.v1.BillingService`. */
    url: env.BILLING_GRPC_URL,
  }));

/**
 * Where the gateway dials billing-service. Read by `BillingApiModule.forRemote()` when the module
 * is defined; deadlines, message limits and TLS stay in the platform `grpc` namespace.
 */
export const billingGrpcClientConfig = defineConfigNamespace(
  'billingGrpcClient',
  billingGrpcClientEnvSchema,
);
export type BillingGrpcClientConfig = ConfigType<typeof billingGrpcClientConfig>;
```
Create `domains/identity/src/infrastructure/adapters/grpc/identity-grpc-client.config.ts`:
```ts
import type { ConfigType } from '@nestjs/config';
import { defineConfigNamespace, zStr } from '@platform/config';
import { z } from 'zod';

export const identityGrpcClientEnvSchema = z
  .object({
    // Any grpc-js target syntax: host:port, dns:///svc:port, … (compose: identity-service:50051).
    IDENTITY_GRPC_URL: zStr('localhost:50051'),
  })
  .transform((env) => ({
    /** Target of `identity.v1` (AuthService, UsersService). */
    url: env.IDENTITY_GRPC_URL,
  }));

/**
 * Where the gateway dials identity-service. Read by `IdentityApiModule.forRemote()` when the module
 * is defined; deadlines, message limits and TLS stay in the platform `grpc` namespace.
 */
export const identityGrpcClientConfig = defineConfigNamespace(
  'identityGrpcClient',
  identityGrpcClientEnvSchema,
);
export type IdentityGrpcClientConfig = ConfigType<typeof identityGrpcClientConfig>;
```
Create `domains/notifications/src/infrastructure/adapters/grpc/notifications-grpc-client.config.ts`:
```ts
import type { ConfigType } from '@nestjs/config';
import { defineConfigNamespace, zStr } from '@platform/config';
import { z } from 'zod';

export const notificationsGrpcClientEnvSchema = z
  .object({
    // Any grpc-js target syntax: host:port, dns:///svc:port, … (compose: notifications-service:50051).
    NOTIFICATIONS_GRPC_URL: zStr('localhost:50052'),
  })
  .transform((env) => ({
    /** Target of `notifications.v1.NotificationsService`. */
    url: env.NOTIFICATIONS_GRPC_URL,
  }));

/**
 * Where the gateway dials notifications-service. Read by `NotificationsApiModule.forRemote()` when
 * the module is defined; deadlines, message limits and TLS stay in the platform `grpc` namespace.
 */
export const notificationsGrpcClientConfig = defineConfigNamespace(
  'notificationsGrpcClient',
  notificationsGrpcClientEnvSchema,
);
export type NotificationsGrpcClientConfig = ConfigType<typeof notificationsGrpcClientConfig>;
```

- [ ] **Step 4: Export them from the domain barrels.**
  - `domains/billing/src/index.ts`: insert `export * from './infrastructure/adapters/grpc/billing-grpc-client.config.js';` immediately
    above `export * from './infrastructure/adapters/grpc/billing-grpc.adapter.js';`.
  - `domains/notifications/src/index.ts`: insert `export * from './infrastructure/adapters/grpc/notifications-grpc-client.config.js';`
    immediately above `export * from './infrastructure/adapters/grpc/notifications-grpc.adapter.js';`.
  - `domains/identity/src/index.ts`: insert, immediately above `// Infrastructure: the Drizzle schema for DatabaseModule / drizzle-kit.`:
```ts
// Infrastructure: where the gateway dials identity-service (IdentityApiModule.forRemote()).
export * from './infrastructure/adapters/grpc/identity-grpc-client.config.js';
```
  - Run `npx biome check --write domains/billing/src domains/identity/src domains/notifications/src`.

- [ ] **Step 5: Run the tests.**
  - `npx vitest run --project billing --project identity --project notifications`. Expected: PASS.
  - `node scripts/check-env-example.mjs`. Expected: exit 0; the variables are still read by the
    platform `grpc` namespace too.
  - `bun run check`. Expected: PASS.

- [ ] **Step 6: Commit.**
```bash
git add domains/billing/src/infrastructure/adapters/grpc/billing-grpc-client.config.ts \
  domains/billing/src/infrastructure/adapters/grpc/billing-grpc-client.config.spec.ts \
  domains/identity/src/infrastructure/adapters/grpc/identity-grpc-client.config.ts \
  domains/identity/src/infrastructure/adapters/grpc/identity-grpc-client.config.spec.ts \
  domains/notifications/src/infrastructure/adapters/grpc/notifications-grpc-client.config.ts \
  domains/notifications/src/infrastructure/adapters/grpc/notifications-grpc-client.config.spec.ts \
  domains/billing/src/index.ts domains/identity/src/index.ts domains/notifications/src/index.ts
git commit -m "refactor(billing,identity,notifications): add per-domain gRPC client target namespaces" -m "identityGrpcClientConfig, notificationsGrpcClientConfig and billingGrpcClientConfig read
IDENTITY_/NOTIFICATIONS_/BILLING_GRPC_URL (names and defaults unchanged) next to each domain's gRPC
adapter, for XApiModule.forRemote() to hand to GrpcClientsModule.register()." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task billing-6: The platform grpc namespace drops the client targets

**Files:**
- Modify: `domains/billing/src/billing-api.module.ts:45` (the `url` passed to `GrpcClientsModule.register`), `domains/identity/src/identity-api.module.ts:62`, `domains/notifications/src/notifications-api.module.ts:47`
- Modify: `libs/config/src/namespaces/grpc.config.ts:10-12,57-62,84`
- Modify: `libs/config/src/namespaces/namespaces.spec.ts:107-113`
- Modify (only when the transport lane left them): `libs/transport/src/grpc/grpc-options.spec.ts:20`, `grpc-retry.spec.ts:100`, `grpc-roundtrip.spec.ts:163`, `grpc-tls.spec.ts:158`
- Modify (docs): `docs/CONFIGURATION.md:101,243,251-253,261`, `libs/config/README.md:38`, `libs/transport/README.md:120`, `docs/DEVELOPMENT.md:309`, `domains/billing/README.md:213`, `domains/identity/README.md:212`, `.env.example:127`, `apps/gateway/.env.example:13`
- Test: `libs/config/src/namespaces/namespaces.spec.ts`, the three `*-grpc.roundtrip.spec.ts`, `apps/gateway/test/app.e2e-spec.ts`

**Interfaces:**
- Consumes:
  - from the transport lane, `GrpcClientsModule.register({ spec: GrpcPackageSpec, url: string })`;
  - from the contracts lane, `IDENTITY_GRPC_PACKAGE`, `NOTIFICATIONS_GRPC_PACKAGE` and `BILLING_GRPC_PACKAGE`, already used in the three `forRemote()`;
  - billing-5's `<x>GrpcClientConfig`.
- Produces:
  - `IdentityApiModule.forRemote()`, `NotificationsApiModule.forRemote()` and `BillingApiModule.forRemote()` dial `<x>GrpcClientConfig.parse().url`.
  - `GrpcConfig` loses `clients`.
  - `grpcEnvSchema` loses `IDENTITY_GRPC_URL`, `NOTIFICATIONS_GRPC_URL` and `BILLING_GRPC_URL`.

- [ ] **Step 1: Write the failing test.** In `libs/config/src/namespaces/namespaces.spec.ts`:

Old:
```ts
    expect(grpcConfig.parse({})).toEqual({
      url: '0.0.0.0:50051',
      clients: {
        identity: 'localhost:50051',
        notifications: 'localhost:50052',
        billing: 'localhost:50053',
      },
      deadlineMs: 5000,
```
New:
```ts
    expect(grpcConfig.parse({})).toEqual({
      url: '0.0.0.0:50051',
      deadlineMs: 5000,
```

- [ ] **Step 2: Run it.** `npx vitest run --project config namespaces.spec`. Expected: FAIL in
  `infrastructure namespaces point at localhost`, `expected { url: '0.0.0.0:50051', clients: {…}, … } to deeply equal { url: '0.0.0.0:50051', … }`.

- [ ] **Step 3: Make each forRemote() dial its own namespace.**
  - In each `forRemote()`, the argument of `GrpcClientsModule.register({ … })` has a `url` property,
    added by the transport lane. Replace that whole property with the line below, whatever
    expression it holds today. If it already reads the domain namespace, leave it. Add the import.
  - `domains/billing/src/billing-api.module.ts`: add
    `import { billingGrpcClientConfig } from './infrastructure/adapters/grpc/billing-grpc-client.config.js';`
    and set:
```ts
        // Read when the module is defined: a client target cannot come from DI.
        url: billingGrpcClientConfig.parse().url,
```
  - `domains/identity/src/identity-api.module.ts`: add
    `import { identityGrpcClientConfig } from './infrastructure/adapters/grpc/identity-grpc-client.config.js';`
    and set:
```ts
        // Read when the module is defined: a client target cannot come from DI.
        url: identityGrpcClientConfig.parse().url,
```
  - `domains/notifications/src/notifications-api.module.ts`: add
    `import { notificationsGrpcClientConfig } from './infrastructure/adapters/grpc/notifications-grpc-client.config.js';`
    and set:
```ts
        // Read when the module is defined: a client target cannot come from DI.
        url: notificationsGrpcClientConfig.parse().url,
```
  - Run `npx biome check --write` on the three files. It removes an import the old expression used,
    such as `grpcConfig`, if that import is now unused.

- [ ] **Step 4: Remove the targets from the platform namespace.** In `libs/config/src/namespaces/grpc.config.ts`:

Old:
```ts
    GRPC_URL: zStr('0.0.0.0:50051'),
    IDENTITY_GRPC_URL: zStr('localhost:50051'),
    NOTIFICATIONS_GRPC_URL: zStr('localhost:50052'),
    BILLING_GRPC_URL: zStr('localhost:50053'),
    GRPC_DEADLINE_MS: zInt(5000, { min: 1 }),
```
New:
```ts
    GRPC_URL: zStr('0.0.0.0:50051'),
    GRPC_DEADLINE_MS: zInt(5000, { min: 1 }),
```
Old:
```ts
    url: env.GRPC_URL,
    /** Client targets (any grpc-js target syntax: `host:port`, `dns:///svc:port`, …). */
    clients: {
      identity: env.IDENTITY_GRPC_URL,
      notifications: env.NOTIFICATIONS_GRPC_URL,
      billing: env.BILLING_GRPC_URL,
    },
    /** Default per-call deadline; every client call MUST have one or a hung upstream pins resources. */
```
New:
```ts
    url: env.GRPC_URL,
    /** Default per-call deadline; every client call MUST have one or a hung upstream pins resources. */
```
Old:
```ts
/** gRPC server bind address, client targets, deadlines, message limits, TLS and reflection. */
```
New:
```ts
/**
 * gRPC server bind address, call deadlines, message limits, TLS and reflection. Client targets
 * belong to each domain (`identityGrpcClient`, `notificationsGrpcClient`, `billingGrpcClient`).
 */
```

- [ ] **Step 5: Remove any reader the other lanes left behind.**
  - `git grep -n -E "\.clients\b|clients\.(identity|notifications|billing)|clients\[" -- apps domains libs` must print nothing.
    Each hit reads a removed property. Replace it with the domain namespace
    (`<x>GrpcClientConfig.parse().url`). In a test that already holds the target in a local
    variable (for example `grpcUrl`), use that variable.
  - `git grep -n -E "(IDENTITY|NOTIFICATIONS|BILLING)_GRPC_URL" -- 'libs/*/src/**'` must print
    nothing. If it prints keys in a `grpcConfig.parse({ … })` env object of a transport spec, delete
    those keys: the platform namespace no longer reads them.
  - The three service e2e specs stub `<X>_GRPC_URL`:
    - `apps/identity-service/test/app.e2e-spec.ts:83`, `apps/notifications-service/test/app.e2e-spec.ts:112` and `apps/billing-service/test/app.e2e-spec.ts:134`.
    - Remove a stub only when the transport lane's rewrite builds that spec's client from the local
      `grpcUrl` and nothing reads the variable any more. Otherwise leave it.
  - Keep `apps/gateway/test/support/e2e-env.ts:21-23`: `forRemote()` reads those three variables
    when the module is defined.
  - Keep `grpcConfig` in `apps/billing-service/src/app.module.ts:7`, which still loads it for `GRPC_URL`.

- [ ] **Step 6: Run the tests.**
  - `npx vitest run --project config --project transport --project billing --project identity --project notifications`.
    Expected: PASS. This includes the three `*-grpc.roundtrip.spec.ts`: each stubs `<X>_GRPC_URL`
    before calling `forRemote()`, and gets through only if `forRemote()` reads the domain namespace.
  - `npx vitest run --project gateway:e2e --project identity-service:e2e --project notifications-service:e2e --project billing-service:e2e`.
    Expected: PASS. The gateway's `billing-service down → 503` case still dials `127.0.0.1:1` from
    `test/support/e2e-env.ts`.
  - `node scripts/check-env-example.mjs`. Expected: exit 0. The three variables are now found only
    in the domain files.

- [ ] **Step 7: Update the docs.**
  - `docs/CONFIGURATION.md`:
    - change `### \`grpc\` — internal RPC (server bind, client targets, TLS)` to `### \`grpc\` — internal RPC (server bind, deadline, message limits, TLS)`;
    - delete the three table rows ``| `IDENTITY_GRPC_URL` ``, ``| `NOTIFICATIONS_GRPC_URL` `` and ``| `BILLING_GRPC_URL` ``;
    - insert this section right after the ``| `GRPC_REFLECTION` `` row and its blank line:
```md
### `identityGrpcClient`, `notificationsGrpcClient`, `billingGrpcClient` — gRPC client targets

One namespace per domain, next to its gRPC adapter, read by that domain's `XApiModule.forRemote()` when the
gateway's module tree is defined:
[`identity-grpc-client.config.ts`](../domains/identity/src/infrastructure/adapters/grpc/identity-grpc-client.config.ts),
[`notifications-grpc-client.config.ts`](../domains/notifications/src/infrastructure/adapters/grpc/notifications-grpc-client.config.ts),
[`billing-grpc-client.config.ts`](../domains/billing/src/infrastructure/adapters/grpc/billing-grpc-client.config.ts)
· gateway. Deadlines, message limits and TLS stay in `grpc`.

| Variable                 | Default           | Description                                                                               |
| ------------------------ | ----------------- | ----------------------------------------------------------------------------------------- |
| `IDENTITY_GRPC_URL`      | `localhost:50051` | identity-service target (any grpc-js target syntax: `host:port`, `dns:///svc:port`, …). |
| `NOTIFICATIONS_GRPC_URL` | `localhost:50052` | notifications-service target.                                                             |
| `BILLING_GRPC_URL`       | `localhost:50053` | billing-service target.                                                                   |
```
    - in "Which app loads which namespace", add three rows right below the ``| `grpc` `` row:
      `identityGrpcClient`, `notificationsGrpcClient` and `billingGrpcClient`. Each gets ✓ under
      gateway only, and its "Loaded by" is `IdentityApiModule.forRemote()`,
      `NotificationsApiModule.forRemote()` or `BillingApiModule.forRemote()`.
  - `libs/config/README.md`: in the ``| `grpc` `` row, delete
    `` `IDENTITY_GRPC_URL` (:50051), `NOTIFICATIONS_GRPC_URL` (:50052), `BILLING_GRPC_URL` (:50053), ``.
  - `libs/transport/README.md`:
    - in the `` - `grpc`: `` bullet, delete `` `IDENTITY_GRPC_URL`, `NOTIFICATIONS_GRPC_URL`, `BILLING_GRPC_URL`, ``;
    - add below it: ``- client targets: each domain's `*GrpcClient` namespace (`IDENTITY_GRPC_URL`, `NOTIFICATIONS_GRPC_URL`, `BILLING_GRPC_URL`), passed in as `url`.``
  - `docs/DEVELOPMENT.md`: replace the paragraph that starts `**3. Client target.**` with:
```md
**3. Client target.** Add `domains/orders/src/infrastructure/adapters/grpc/orders-grpc-client.config.ts`, a copy of `billing-grpc-client.config.ts` with the namespace `ordersGrpcClient` and `ORDERS_GRPC_URL: zStr('localhost:50054')`. `OrdersApiModule.forRemote()` passes `ordersGrpcClientConfig.parse().url` as the `url` of `GrpcClientsModule.register()`. Document the variable in the root `.env.example` and in `apps/gateway/.env.example`.
```
  - `domains/billing/README.md`: change `Gateway: \`BILLING_GRPC_URL\`, \`GRPC_DEADLINE_MS\`.` to
    ``Gateway: `BILLING_GRPC_URL` (`billingGrpcClient` namespace, `src/infrastructure/adapters/grpc/billing-grpc-client.config.ts`), `GRPC_DEADLINE_MS` (platform `grpc`).``
  - `domains/identity/README.md`: change `` `grpc` (`IDENTITY_GRPC_URL`, `GRPC_DEADLINE_MS`) for the gateway `` to
    `` `identityGrpcClient` (`IDENTITY_GRPC_URL`) and `grpc` (`GRPC_DEADLINE_MS`) for the gateway ``.
  - `.env.example`: Old `IDENTITY_GRPC_URL=localhost:50051` → New:
```
# Client targets (gateway), one namespace per domain read by each XApiModule.forRemote():
# identityGrpcClient, notificationsGrpcClient, billingGrpcClient
IDENTITY_GRPC_URL=localhost:50051
```
  - `apps/gateway/.env.example`: change `# Upstream gRPC services (host:port) and the per-call deadline (ms).` to
    `# Upstream gRPC services (host:port; each domain's *GrpcClient namespace) and the per-call deadline (ms).`
  - Run `npx prettier --write docs/CONFIGURATION.md libs/config/README.md libs/transport/README.md docs/DEVELOPMENT.md domains/billing/README.md domains/identity/README.md`, then `bun run check`.
    Expected: PASS.

- [ ] **Step 8: Commit.**
```bash
git add domains/billing/src/billing-api.module.ts domains/identity/src/identity-api.module.ts \
  domains/notifications/src/notifications-api.module.ts libs/config/src/namespaces/grpc.config.ts \
  libs/config/src/namespaces/namespaces.spec.ts libs/transport/src/grpc \
  docs/CONFIGURATION.md libs/config/README.md libs/transport/README.md docs/DEVELOPMENT.md \
  domains/billing/README.md domains/identity/README.md .env.example apps/gateway/.env.example
git commit -m "refactor(config,billing,identity,notifications): drop client targets from the grpc namespace" -m "Each XApiModule.forRemote() dials the URL of its own domain namespace. The platform grpc
namespace keeps the server bind, deadline, message limits, TLS and reflection. Env names and
defaults are unchanged." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
(`libs/transport/src/grpc` stages only the transport specs Step 5 edited. If Step 5 changed nothing there, drop that path.)

---

### Task billing-7: Upload limits in a files namespace

**Files:**
- Create: `domains/files/src/files.config.ts`, `domains/files/src/files.config.spec.ts`
- Modify: `domains/files/src/files.module.ts:4,19-27`, `domains/files/src/application/files.service.ts:3,12,42`
- Modify: `domains/files/src/application/files.service.spec.ts:5,18,111`, `domains/files/src/presentation/graphql/files.resolver.spec.ts:7,85`, `domains/files/src/testing/files-test-app.test.ts:7-10,56-63`
- Modify: `domains/files/src/index.ts:13`
- Modify: `libs/config/src/namespaces/storage.config.ts` (D's version: the two `STORAGE_MAX_*` keys, the two transform fields, the doc comment)
- Modify: `libs/config/src/namespaces/namespaces.spec.ts:127,248` (+ one new test)
- Modify (docs): `domains/files/README.md:52-53,134,140,148`, `libs/config/README.md:44,47-48`, `libs/storage/README.md:59`, `docs/CONFIGURATION.md:107,347-348,364`, `.env.example:200`
- Test: `domains/files/src/files.config.spec.ts`, `libs/config/src/namespaces/namespaces.spec.ts`, the files project

**Interfaces:**
- Consumes:
  - from the platform lane, `scripts/check-env-example.mjs` scanning `domains/**/src/**/*.config.ts`;
  - D's `storage.config.ts`;
  - `defineConfigNamespace` and `zInt` from `@platform/config`.
- Produces:
  - In `domains/files/src/files.config.ts`, re-exported by `@domain/files`:
    - `filesConfig`, created with `defineConfigNamespace('files', filesEnvSchema)` (token `CONFIGURATION(files)`);
    - its value has type `{ maxUploadBytes: number; maxConcurrentUploads: number }`;
    - it reads `STORAGE_MAX_UPLOAD_BYTES` (default 26214400) and `STORAGE_MAX_CONCURRENT_UPLOADS` (default 4);
    - also exports `type FilesConfig` and `filesEnvSchema`.
  - `FilesService` injects `filesConfig.KEY`.
  - `StorageConfig` loses `maxUploadBytes` and `maxConcurrentUploads`.

- [ ] **Step 1: Write the failing tests.** Create `domains/files/src/files.config.spec.ts`:
```ts
import { EnvValidationError } from '@platform/config';
import { describe, expect, it } from 'vitest';
import { filesConfig } from './files.config.js';

const errorOf = (fn: () => unknown): EnvValidationError => {
  try {
    fn();
  } catch (error) {
    if (error instanceof EnvValidationError) return error;
    throw error;
  }
  throw new Error('expected an EnvValidationError');
};

describe('filesConfig (the files namespace: upload limits)', () => {
  it('defaults to 25 MiB per file and 4 streamed uploads per process', () => {
    expect(filesConfig.parse({})).toEqual({ maxUploadBytes: 26_214_400, maxConcurrentUploads: 4 });
  });

  it('reads the STORAGE_MAX_* variables (names unchanged)', () => {
    expect(
      filesConfig.parse({ STORAGE_MAX_UPLOAD_BYTES: '1024', STORAGE_MAX_CONCURRENT_UPLOADS: '2' }),
    ).toEqual({ maxUploadBytes: 1024, maxConcurrentUploads: 2 });
  });

  it.each([
    ['STORAGE_MAX_UPLOAD_BYTES', '0'],
    ['STORAGE_MAX_UPLOAD_BYTES', '1.5'],
    ['STORAGE_MAX_CONCURRENT_UPLOADS', '0'],
  ])('rejects %s=%s, naming the variable', (variable, value) => {
    const error = errorOf(() => filesConfig.parse({ [variable]: value }));
    expect(error.namespace).toBe('files');
    expect(error.message).toContain('Invalid environment for "files"');
    expect(error.message).toContain(`→ at ${variable}`);
  });

  it('is registered under the "files" key', () => {
    expect(filesConfig.KEY).toBe('CONFIGURATION(files)');
  });
});
```
  In `libs/config/src/namespaces/namespaces.spec.ts`:

Old:
```ts
  it('storage: public endpoint defaults to the endpoint', () => {
```
New:
```ts
  it('storage holds no upload limits (the files namespace of @domain/files owns them)', () => {
    const storage = storageConfig.parse({ STORAGE_MAX_UPLOAD_BYTES: '1024' });
    expect(storage).not.toHaveProperty('maxUploadBytes');
    expect(storage).not.toHaveProperty('maxConcurrentUploads');
  });

  it('storage: public endpoint defaults to the endpoint', () => {
```

- [ ] **Step 2: Run them.** `npx vitest run --project files --project config files.config.spec namespaces.spec`. Expected: FAIL.
  - `files.config.spec.ts` fails to load: `Failed to load url ./files.config.js`.
  - `namespaces.spec.ts > storage holds no upload limits…` fails: `expected { driver: 's3', maxUploadBytes: 1024, … } to not have property "maxUploadBytes"`.

- [ ] **Step 3: Create the namespace.** Create `domains/files/src/files.config.ts`:
```ts
import type { ConfigType } from '@nestjs/config';
import { defineConfigNamespace, zInt } from '@platform/config';
import { z } from 'zod';

export const filesEnvSchema = z
  .object({
    STORAGE_MAX_UPLOAD_BYTES: zInt(26_214_400, { min: 1 }),
    STORAGE_MAX_CONCURRENT_UPLOADS: zInt(4, { min: 1 }),
  })
  .transform((env) => ({
    /** Per file: streamed uploads (multipart `limits.fileSize`) and presigned ones (`contentLength`). */
    maxUploadBytes: env.STORAGE_MAX_UPLOAD_BYTES,
    /** Streamed (API-proxied) uploads in flight per process; more get a 503 (memory bound). */
    maxConcurrentUploads: env.STORAGE_MAX_CONCURRENT_UPLOADS,
  }));

/**
 * Upload limits of the files context. The variables keep their `STORAGE_` names (no deployment
 * churn); the driver, bucket and presign settings stay in the platform `storage` namespace.
 */
export const filesConfig = defineConfigNamespace('files', filesEnvSchema);
export type FilesConfig = ConfigType<typeof filesConfig>;
```
  In `domains/files/src/index.ts`, change `export * from './files.constants.js';` to
  `export * from './files.config.js';` followed by `export * from './files.constants.js';`.

- [ ] **Step 4: Switch the files context to its namespace.**
  - `domains/files/src/files.module.ts`:

Old:
```ts
import { type StorageConfig, storageConfig } from '@platform/config';
import { FilesService } from './application/files.service.js';
```
New:
```ts
import { FilesService } from './application/files.service.js';
import { type FilesConfig, filesConfig } from './files.config.js';
```
Old:
```ts
    ConfigModule.forFeature(storageConfig),
    // Module-wide default of every upload interceptor declared in this module: the per-file
    // byte limit comes from config (a decorator argument can't read it).
    MultipartModule.registerAsync({
      imports: [ConfigModule.forFeature(storageConfig)],
      inject: [storageConfig.KEY],
      useFactory: (cfg: StorageConfig): MultipartModuleOptions => ({
```
New:
```ts
    // The files context's own namespace (upload limits); storage settings belong to StorageModule.
    ConfigModule.forFeature(filesConfig),
    // Module-wide default of every upload interceptor declared in this module: the per-file
    // byte limit comes from config (a decorator argument can't read it).
    MultipartModule.registerAsync({
      imports: [ConfigModule.forFeature(filesConfig)],
      inject: [filesConfig.KEY],
      useFactory: (cfg: FilesConfig): MultipartModuleOptions => ({
```
  - `domains/files/src/application/files.service.ts`:
    - delete `import { type StorageConfig, storageConfig } from '@platform/config';`;
    - change `import { UPLOAD_RETRY_AFTER_SEC } from '../files.constants.js';` to
      `import { type FilesConfig, filesConfig } from '../files.config.js';` followed by
      `import { UPLOAD_RETRY_AFTER_SEC } from '../files.constants.js';`;
    - change `    @Inject(storageConfig.KEY) private readonly config: StorageConfig,` to
      `    @Inject(filesConfig.KEY) private readonly config: FilesConfig,`.
  - `domains/files/src/application/files.service.spec.ts`:
    - delete `import { type StorageConfig, storageConfig } from '@platform/config';`;
    - add `import { type FilesConfig, filesConfig } from '../files.config.js';` after the `../domain/files.errors.js` import;
    - change `const config: StorageConfig = storageConfig.parse({ STORAGE_MAX_UPLOAD_BYTES: '1000' });` to
      `const config: FilesConfig = filesConfig.parse({ STORAGE_MAX_UPLOAD_BYTES: '1000' });`;
    - change `    const capped: StorageConfig = storageConfig.parse({` to
      `    const capped: FilesConfig = filesConfig.parse({`.
  - `domains/files/src/presentation/graphql/files.resolver.spec.ts`:
    - delete `import { storageConfig } from '@platform/config';`;
    - add `import { filesConfig } from '../../files.config.js';` after the `../../domain/files.errors.js` import;
    - change `    const config = storageConfig.parse({ STORAGE_MAX_UPLOAD_BYTES: '1024' });` to
      `    const config = filesConfig.parse({ STORAGE_MAX_UPLOAD_BYTES: '1024' });`.
  - `domains/files/src/testing/files-test-app.test.ts`:
    - after `import { createFastifyTestApp } from '@platform/testing';`, add `import { filesConfig } from '../files.config.js';`.
      Keep `import { storageConfig } from '@platform/config';`: the storage override stays.
    - old:
```ts
    .overrideProvider(storageConfig.KEY)
    .useValue(
      storageConfig.parse({
        STORAGE_MAX_UPLOAD_BYTES: String(options.maxUploadBytes ?? 4096),
```
      new:
```ts
    // Storage defaults whatever the process environment holds (as before the limits moved).
    .overrideProvider(storageConfig.KEY)
    .useValue(storageConfig.parse({}))
    .overrideProvider(filesConfig.KEY)
    .useValue(
      filesConfig.parse({
        STORAGE_MAX_UPLOAD_BYTES: String(options.maxUploadBytes ?? 4096),
```
  - Run `npx biome check --write domains/files/src`.

- [ ] **Step 5: Remove the limits from the platform storage namespace.** In
  `libs/config/src/namespaces/storage.config.ts` (D's version), make targeted deletions:
  - in the `z.object({ … })`, delete the lines `    STORAGE_MAX_UPLOAD_BYTES: zInt(26_214_400, { min: 1 }),` and
    `    STORAGE_MAX_CONCURRENT_UPLOADS: zInt(4, { min: 1 }),`;
  - in `.transform(…)`, delete these three lines:
```ts
    maxUploadBytes: env.STORAGE_MAX_UPLOAD_BYTES,
    /** Streamed (API-proxied) uploads in flight per process; more get a 503 (memory bound). */
    maxConcurrentUploads: env.STORAGE_MAX_CONCURRENT_UPLOADS,
```
  - change the doc comment
    `/** Object storage (S3-compatible or Google Cloud Storage), upload limits, presigned URL TTL. */` to
    `/** Object storage (S3-compatible or Google Cloud Storage) and presigned URL TTL (upload limits: \`files\`). */`.

  Keep the `zInt` import: `STORAGE_SIGNED_URL_TTL_SEC` still uses it.

  In `libs/config/src/namespaces/namespaces.spec.ts`:
  - delete the line `      maxConcurrentUploads: 4,` in the `storageConfig.parse({})` expectation;
  - delete the row `    [storageConfig, { STORAGE_MAX_CONCURRENT_UPLOADS: '0' }, 'STORAGE_MAX_CONCURRENT_UPLOADS'],`. `files.config.spec.ts` covers it now.

  `git grep -n -E "maxUploadBytes|maxConcurrentUploads" -- 'libs/*/src/**'` must print only the
  lines of the new `storage holds no upload limits…` test in `namespaces.spec.ts`. The env names
  still appear in READMEs (fixed in Step 7) and in a comment in `s3-storage.driver.ts`; both are
  correct.

- [ ] **Step 6: Run the tests.**
  - `npx vitest run --project files --project config --project storage --project bootstrap`. Expected: PASS.
  - `npx vitest run --project monolith:e2e --project gateway:e2e`. Expected: PASS (`POST /v1/files` streams an upload).
  - `node scripts/check-env-example.mjs`. Expected: exit 0; `STORAGE_MAX_*` are found in `domains/files/src/files.config.ts`.
  - `bun run check`. Expected: PASS.

- [ ] **Step 7: Update the docs.**
  - `domains/files/README.md`:
    - change ``imports `ConfigModule.forFeature(storageConfig)` and`` to ``imports `ConfigModule.forFeature(filesConfig)` (its own `files` namespace) and``;
    - change `## Configuration (\`storage\` namespace)` to `## Configuration (\`files\` namespace, \`src/files.config.ts\`)`;
    - in that section, change `` `STORAGE_SIGNED_URL_TTL_SEC` (900) is `` to
      `` The variables keep their `STORAGE_` names. `STORAGE_SIGNED_URL_TTL_SEC` (900, platform `storage` namespace) is ``;
    - in Public API, append `` , `filesConfig` / `FilesConfig` (the `files` namespace)`` to the `FilesModule`, `FilesService` bullet.
  - `libs/config/README.md`:
    - in the ``| `storage` `` row, delete `` `STORAGE_MAX_UPLOAD_BYTES` (25 MiB), ``;
    - old:
      ```md
      `storage` also reads `STORAGE_MAX_CONCURRENT_UPLOADS` (4): streamed uploads in flight per process (`@domain/files`
      answers 503 beyond it; each one holds ~15 MiB off-heap).
      ```
      new:
      ```md
      Upload limits (`STORAGE_MAX_UPLOAD_BYTES`, `STORAGE_MAX_CONCURRENT_UPLOADS`) are not part of `storage`: they are the
      `files` namespace of `@domain/files` (`domains/files/src/files.config.ts`).
      ```
  - `libs/storage/README.md`:
    - delete `` `STORAGE_MAX_UPLOAD_BYTES` (read by `@domain/files`), ``;
    - after the variable list, add the line
      `` Upload limits (`STORAGE_MAX_UPLOAD_BYTES`, `STORAGE_MAX_CONCURRENT_UPLOADS`) are the `files` namespace of `@domain/files`.``
  - `docs/CONFIGURATION.md`:
    - in the matrix:
      - change the ``| `storage` `` row's "Loaded by" from `` `StorageModule`, `FilesModule` `` to `` `StorageModule` ``;
      - add a row below it: `` | `files` | ✓ | ✓ | | | | `FilesModule` | ``.
    - in the `storage` table, delete the ``| `STORAGE_MAX_UPLOAD_BYTES` `` and ``| `STORAGE_MAX_CONCURRENT_UPLOADS` `` rows.
    - insert this section immediately above `### \`stripe\` — Checkout + webhooks`:
```md
### `files` — upload limits

[`files.config.ts`](../domains/files/src/files.config.ts) (owned by the files domain) · gateway, monolith

| Variable                         | Default    | Description                                                                                                                   |
| -------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `STORAGE_MAX_UPLOAD_BYTES`       | `26214400` | 25 MiB per file: streamed uploads (multipart `limits.fileSize`) and presigned ones (the signed `contentLength`).             |
| `STORAGE_MAX_CONCURRENT_UPLOADS` | `4`        | Streamed uploads (`POST /v1/files`) in flight per process; more get `503` + `Retry-After`. Each holds up to ~15 MiB off-heap. |
```
  - `.env.example`: change `# 25 MiB` (above `# STORAGE_MAX_UPLOAD_BYTES=26214400`) to
    `# Upload limits are the files namespace (domains/files/src/files.config.ts). 25 MiB:`.
  - Run `npx prettier --write domains/files/README.md libs/config/README.md libs/storage/README.md docs/CONFIGURATION.md`, then `bun run check`.
    Expected: PASS.

- [ ] **Step 8: Commit.**
```bash
git add domains/files/src/files.config.ts domains/files/src/files.config.spec.ts domains/files/src/files.module.ts \
  domains/files/src/application/files.service.ts domains/files/src/application/files.service.spec.ts \
  domains/files/src/presentation/graphql/files.resolver.spec.ts domains/files/src/testing/files-test-app.test.ts \
  domains/files/src/index.ts libs/config/src/namespaces/storage.config.ts libs/config/src/namespaces/namespaces.spec.ts \
  domains/files/README.md libs/config/README.md libs/storage/README.md docs/CONFIGURATION.md .env.example
git commit -m "refactor(files,config): move the upload limits into a files namespace" -m "filesConfig (namespace files) reads STORAGE_MAX_UPLOAD_BYTES and STORAGE_MAX_CONCURRENT_UPLOADS
(names and defaults unchanged); the platform storage namespace keeps the driver, bucket and
presign settings." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

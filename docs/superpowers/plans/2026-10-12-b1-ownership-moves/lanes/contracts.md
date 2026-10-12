> Lane **contracts** of B1: per-domain contracts packages and the value-based transport API. Four tasks, run in order: contracts-1 → contracts-2 → contracts-3 (before the other lanes' tasks that name the new values or packages) → contracts-4 (last, after lane billing's `PaymentUserFieldResolver` task).
> - Line numbers refer to each file as it is at the start of its task. Every snippet was applied to a replica of HEAD `74f70b7` (H + D landed) and checked with tsc, Biome, ESLint, Prettier and the full Vitest suite (final state: 225 files / 1748 tests), then this text was executed end to end and reproduced the same four trees byte for byte.
> - Mechanical edits ship as exact patches in `docs/superpowers/plans/2026-10-12-b1-ownership-moves/artifacts/contracts/patches/` (applied with `git apply --index` on the tree the previous step left). If one does not apply because another lane changed a context line, use `git apply --3way --index <patch>`, or apply by hand the old → new snippets of the same step in `docs/superpowers/plans/2026-10-12-b1-ownership-moves/artifacts/contracts/plan-contracts-lane.md` (identical content, everything inline). The two codemods live in `docs/superpowers/plans/2026-10-12-b1-ownership-moves/artifacts/contracts/codemods/`. If any inline snippet here disagrees with `docs/superpowers/plans/2026-10-12-b1-ownership-moves/artifacts/contracts/plan-contracts-lane.md` or a patch, the file wins.

### Task contracts-1: gRPC packages as values (`GrpcPackageSpec`)

**Files:**
- Move: `libs/contracts/src/grpc/grpc-packages.ts` -> `libs/contracts/src/grpc/grpc-package-spec.ts`
- Create: `libs/contracts/src/grpc/grpc-package-spec.spec.ts`
- Create: `libs/contracts/src/grpc/identity.grpc-package.ts`
- Create: `libs/contracts/src/grpc/billing.grpc-package.ts`
- Create: `libs/contracts/src/grpc/notifications.grpc-package.ts`
- Create: `libs/transport/test/fixtures/src/proto/fixture/v1/fixture.proto`
- Create: `libs/transport/test/fixtures/echo-proto/echo/v1/echo.proto`
- Create: `libs/transport/test/fixtures/fixture.grpc-package.ts`
- Modify: `libs/contracts/src/grpc/grpc-package-spec.ts` (whole file)
- Modify: `libs/contracts/src/index.ts:12-13,30`
- Modify: `libs/contracts/package.json:13`
- Modify: `libs/contracts/buf.gen.yaml:4`
- Modify: `libs/transport/package.json:19-20,43-46`
- Modify: `package.json:154`
- Modify: `libs/transport/src/grpc/grpc-client.options.ts:6-7,8,13-14,21,92-96,100,103,113,116-117`
- Modify: `libs/transport/src/grpc/grpc-clients.module.ts:5-7,9,19-21,30-33,35-37,41-43`
- Modify: `domains/identity/src/identity-api.module.ts:1-2,37,59-62`
- Modify: `domains/billing/src/billing-api.module.ts:1-2,41-45`
- Modify: `domains/notifications/src/notifications-api.module.ts:1-2,23,44-47`
- Modify: `.github/workflows/ci.yml:80,81`
- Delete: `libs/contracts/src/grpc/grpc-packages.spec.ts`
- Create/Modify (exact edits in patch `contracts-1-step01.patch`): `libs/contracts/src/grpc/identity.grpc-package.spec.ts`, `libs/contracts/src/grpc/billing.grpc-package.spec.ts`, `libs/contracts/src/grpc/notifications.grpc-package.spec.ts`
- Create/Modify (exact edits in patch `contracts-1-step03.patch`): `libs/contracts/src/testing/grpc-wire.ts`, `libs/contracts/src/testing/index.ts`
- Create/Modify (exact edits in patch `contracts-1-step07.patch`): `libs/transport/src/grpc/grpc-options.spec.ts`, `libs/transport/src/grpc/grpc-clients.module.spec.ts`, `libs/transport/src/grpc/grpc-retry.spec.ts`, `libs/transport/src/grpc/grpc-roundtrip.spec.ts`, `libs/transport/src/grpc/grpc-tls.spec.ts`, `libs/transport/src/hybrid/connect-microservices.spec.ts`
- Create/Modify (exact edits in patch `contracts-1-step09.patch`): `libs/transport/src/grpc/grpc-server.options.ts`, `libs/transport/src/hybrid/connect-microservices.ts`, `libs/transport/src/grpc/grpc-controller.decorator.ts`
- Create/Modify (exact edits in patch `contracts-1-step11.patch`): `domains/identity/src/infrastructure/adapters/grpc/auth-grpc.adapter.ts`, `domains/identity/src/infrastructure/adapters/grpc/users-grpc.adapter.ts`, `domains/identity/src/identity-grpc.module.ts`, `domains/billing/src/infrastructure/adapters/grpc/billing-grpc.adapter.ts`, `domains/billing/src/billing-grpc.module.ts`, `domains/notifications/src/infrastructure/adapters/grpc/notifications-grpc.adapter.ts`, `domains/notifications/src/notifications-grpc.module.ts`, `domains/identity/src/presentation/grpc/identity-grpc.roundtrip.spec.ts`, `domains/billing/src/presentation/grpc/billing-grpc.roundtrip.spec.ts`, `domains/notifications/src/presentation/grpc/notifications-grpc.roundtrip.spec.ts`
- Create/Modify (exact edits in patch `contracts-1-step12.patch`): `apps/identity-service/src/main.ts`, `apps/identity-service/test/support/service-test-app.ts`, `apps/billing-service/src/main.ts`, `apps/billing-service/test/support/service-test-app.ts`, `apps/notifications-service/src/main.ts`, `apps/notifications-service/test/support/service-test-app.ts`, `apps/identity-service/test/app.e2e-spec.ts`, `apps/billing-service/test/app.e2e-spec.ts`, `apps/notifications-service/test/app.e2e-spec.ts`
- Create/Modify (exact edits in patch `contracts-1-step14.patch`): `libs/transport/README.md`
- Create (generated by Step 6): `libs/transport/test/fixtures/src/generated/fixture/v1/fixture.pb.ts`, `libs/transport/test/fixtures/src/generated/google/protobuf/timestamp.pb.ts`
- Test: `npx vitest run --project contracts`
- Test: `npx vitest run --project transport`
- Test: `identity`, `billing`, `notifications`, `identity-service:e2e`, `billing-service:e2e`, `notifications-service:e2e`, `gateway:e2e`, `monolith:e2e`

**Interfaces:**
- Consumes: nothing from other lanes (reads `grpcConfig.clients.<x>` from `@platform/config` as it is today).
- Produces (`@platform/contracts`): `interface GrpcPackageSpec { readonly package: string; readonly protoDir: string; readonly protoPath: readonly string[]; readonly services: readonly string[]; readonly clientToken: string; readonly idempotentMethods: Readonly<Record<string, readonly string[]>> }`; `GRPC_LOADER_OPTIONS` (no `includeDirs`); `resolveGrpcPackages(specs: readonly GrpcPackageSpec[]): ResolvedGrpcPackages` with `includeDirs: string[]`; `IDENTITY_GRPC_PACKAGE`, `BILLING_GRPC_PACKAGE`, `NOTIFICATIONS_GRPC_PACKAGE: GrpcPackageSpec` (exported from `@platform/contracts` until Task contracts-3); subpath `@platform/contracts/testing`: `loadGrpcPackages(specs)`, `wireRoundTrip(root, typeName, value)`, `protoFilesUnder(dir)`, `boundRpcPatterns(decorator, service)`. Removed: `PROTO_DIR`, `GRPC_PACKAGES`, `GrpcPackageName`, `GRPC_PACKAGE_NAMES`, `isGrpcPackageName`.
- Produces (`@platform/transport`): `interface GrpcClientTarget { readonly spec: GrpcPackageSpec; readonly url: string }`; `GrpcClientsModule.register(target: GrpcClientTarget, options?: GrpcClientsModuleOptions): DynamicModule`; `createGrpcClientOptions(cfg: GrpcConfig, target: GrpcClientTarget, extras?: GrpcClientOptionsExtras): GrpcOptions`; `createGrpcServerOptions(cfg, packages: readonly GrpcPackageSpec[], extras?)`; `createGrpcServerStrategy(cfg, packages: readonly GrpcPackageSpec[], extras?)`; `connectGrpcServer(app, packages: readonly GrpcPackageSpec[], extras?)`. Fixtures: `libs/transport/test/fixtures/fixture.grpc-package.ts` (`FIXTURE_GRPC_PACKAGE`, `ECHO_GRPC_PACKAGE`, re-exported ts-proto types).

- [ ] **Step 1: Write the failing @platform/contracts specs (generic resolver + one spec per package)**

The old `grpc-packages.spec.ts` tested the cross-domain registry; it is replaced by a generic `resolveGrpcPackages` spec over inline specs, and by one spec per package that later moves with it (`git mv`) into `domains/<x>/contracts` unchanged. They import the helpers through `@platform/contracts/testing` and the package through `../index.js`, so the move needs no edit.

```bash
git rm libs/contracts/src/grpc/grpc-packages.spec.ts
```

Create `libs/contracts/src/grpc/grpc-package-spec.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  GRPC_LOADER_OPTIONS,
  type GrpcPackageSpec,
  resolveGrpcPackages,
} from './grpc-package-spec.js';

const ORDERS: GrpcPackageSpec = {
  package: 'orders.v1',
  protoDir: '/contracts/orders/proto',
  protoPath: ['orders/v1/orders.proto'],
  services: ['OrdersService', 'CartsService'],
  clientToken: 'ORDERS_GRPC_CLIENT',
  idempotentMethods: { OrdersService: ['GetOrder', 'ListOrders'] },
};

const SHIPPING: GrpcPackageSpec = {
  package: 'shipping.v1',
  protoDir: '/contracts/shipping/proto',
  protoPath: ['shipping/v1/shipping.proto'],
  services: ['ShippingService'],
  clientToken: 'SHIPPING_GRPC_CLIENT',
  idempotentMethods: {},
};

describe('resolveGrpcPackages', () => {
  it('keeps input order, drops a package listed twice and merges the include dirs', () => {
    expect(resolveGrpcPackages([SHIPPING, ORDERS, { ...SHIPPING }])).toEqual({
      packages: ['shipping.v1', 'orders.v1'],
      protoPath: ['shipping/v1/shipping.proto', 'orders/v1/orders.proto'],
      includeDirs: ['/contracts/shipping/proto', '/contracts/orders/proto'],
      services: [
        'shipping.v1.ShippingService',
        'orders.v1.OrdersService',
        'orders.v1.CartsService',
      ],
      idempotentMethods: [
        { service: 'orders.v1.OrdersService', method: 'GetOrder' },
        { service: 'orders.v1.OrdersService', method: 'ListOrders' },
      ],
    });
  });

  it('shares one include dir between packages of the same contracts package', () => {
    const carts: GrpcPackageSpec = {
      ...ORDERS,
      package: 'carts.v1',
      protoPath: ['carts/v1/carts.proto'],
    };
    expect(resolveGrpcPackages([ORDERS, carts]).includeDirs).toEqual(['/contracts/orders/proto']);
  });

  it('returns empty arrays for no packages', () => {
    expect(resolveGrpcPackages([])).toEqual({
      packages: [],
      protoPath: [],
      includeDirs: [],
      services: [],
      idempotentMethods: [],
    });
  });
});

describe('GRPC_LOADER_OPTIONS', () => {
  it('mirrors the ts-proto options and leaves includeDirs to each call', () => {
    expect(GRPC_LOADER_OPTIONS).toEqual({
      keepCase: false,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });
  });
});
```

Apply the validated patch with these exact edits (the old -> new snippets are also in `docs/superpowers/plans/2026-10-12-b1-ownership-moves/artifacts/contracts/plan-contracts-lane.md`, contracts-1 Step 1, for hand application):

```bash
git apply --index docs/superpowers/plans/2026-10-12-b1-ownership-moves/artifacts/contracts/patches/contracts-1-step01.patch
```

Expected: applies cleanly and stages exactly: `libs/contracts/src/grpc/billing.grpc-package.spec.ts`, `libs/contracts/src/grpc/identity.grpc-package.spec.ts`, `libs/contracts/src/grpc/notifications.grpc-package.spec.ts`.

- [ ] **Step 2: Run the contracts project and watch it fail**

```bash
npx vitest run --project contracts
```

Expected: FAIL, 4 files: `Error: Cannot find module './grpc-package-spec.js'` and `Error: "./testing" is not exported under the conditions ["@repo/source", ...] from package .../libs/contracts`.


- [ ] **Step 3: Implement the generic package spec, the three package specs and the testing helper**

`GrpcPackageSpec` gains `protoDir` (the absolute proto root of its contracts package) because one shared `PROTO_DIR` no longer exists; `resolveGrpcPackages` takes specs and returns `includeDirs`; `GRPC_LOADER_OPTIONS` loses `includeDirs`. The registry (`GRPC_PACKAGES`, `GrpcPackageName`, `GRPC_PACKAGE_NAMES`, `isGrpcPackageName`, `PROTO_DIR`) is deleted. `IDENTITY_GRPC_PACKAGE`, `BILLING_GRPC_PACKAGE` and `NOTIFICATIONS_GRPC_PACKAGE` live in `libs/contracts/src/grpc/` only until Task contracts-3 moves them; each value-imports its generated module (Timestamp wrapper). The `@platform/contracts/testing` helpers (`loadGrpcPackages`, `wireRoundTrip`, `protoFilesUnder`, `boundRpcPatterns`) load protos exactly like proto-loader on the shared protobufjs instance.

```bash
git mv libs/contracts/src/grpc/grpc-packages.ts libs/contracts/src/grpc/grpc-package-spec.ts
```

Replace the whole content of `libs/contracts/src/grpc/grpc-package-spec.ts`:

```ts
import type { GrpcOptions } from '@nestjs/microservices';

/**
 * Static description of one versioned protobuf package served over gRPC. Each domain's contracts
 * package exports one per package (`ORDERS_GRPC_PACKAGE`, …); transport only ever takes these
 * values, never a package name.
 */
export interface GrpcPackageSpec {
  /** Protobuf `package` (as declared in the .proto file). */
  readonly package: string;
  /**
   * Absolute directory `protoPath` is relative to: `<contracts package>/src/proto` from sources,
   * `<contracts package>/dist/proto` after the build (swc `copyFiles`). Transport passes it to
   * proto-loader in `includeDirs`.
   */
  readonly protoDir: string;
  /** Proto files relative to `protoDir`, namespaced by package (`orders/v1/orders.proto`). */
  readonly protoPath: readonly string[];
  /** Unqualified service names, as used by `@GrpcMethod` and `ClientGrpc.getService()`. */
  readonly services: readonly string[];
  /** DI token of the `ClientGrpc` that `GrpcClientsModule.register()` provides for this package. */
  readonly clientToken: string;
  /**
   * Side-effect-free rpcs (proto method names, by unqualified service): the ONLY methods clients
   * retry automatically on `UNAVAILABLE`. A server can commit a mutation and then die before
   * answering; a replayed token refresh would then trip refresh-token reuse detection, a
   * replayed sign-up would fail with a conflict, and so on. Add a method here only if running it
   * twice is harmless.
   */
  readonly idempotentMethods: Readonly<Record<string, readonly string[]>>;
}

/** proto-loader options accepted by Nest's gRPC transport (`GrpcOptions['options']['loader']`). */
export type GrpcLoaderOptions = NonNullable<GrpcOptions['options']['loader']>;

/**
 * proto-loader options for BOTH servers and clients. They MUST mirror the ts-proto options in
 * `buf.gen.yaml`, otherwise runtime values contradict the generated types:
 * - `keepCase: false` <-> snake_to_camel field names (`display_name` -> `displayName`)
 * - `longs: String`   <-> `forceLong=string` (int64 stays exact beyond 2^53)
 * - `enums: String`   <-> `stringEnums=true`
 * - `defaults: true`  <-> non-optional scalars/arrays are always present. Absent *message* fields
 *   decode as `null` (not `undefined`) — check them with `== null`.
 * - `oneofs: true`    proto3 `optional` fields also get a synthetic `_field` key; map to DTOs
 *   instead of returning decoded objects verbatim.
 *
 * `includeDirs` is per call: `resolveGrpcPackages(specs).includeDirs`.
 */
export const GRPC_LOADER_OPTIONS = {
  keepCase: false,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
} satisfies GrpcLoaderOptions;

/** Everything a gRPC server/client needs for a set of packages, deduplicated. */
export interface ResolvedGrpcPackages {
  /** Protobuf package names for `GrpcOptions.options.package`. */
  readonly packages: string[];
  /** Proto files for `GrpcOptions.options.protoPath`, each relative to one of `includeDirs`. */
  readonly protoPath: string[];
  /** Every package's `protoDir`, for proto-loader's `includeDirs`. */
  readonly includeDirs: string[];
  /**
   * Fully-qualified service names (`orders.v1.OrdersService`): the keys grpc health checking,
   * server reflection and service-config `methodConfig[].name[].service` expect.
   */
  readonly services: string[];
  /**
   * `{ service, method }` names (gRFC A6 `methodConfig[].name[]`) of every idempotent rpc of the
   * packages (`GrpcPackageSpec.idempotentMethods`), with fully-qualified service names.
   */
  readonly idempotentMethods: GrpcMethodName[];
}

/** A fully-qualified service plus a proto method name (`orders.v1.OrdersService` / `GetOrder`). */
export interface GrpcMethodName {
  readonly service: string;
  readonly method: string;
}

/**
 * Resolves package specs into the arrays Nest's `GrpcOptions` and grpc-js service config need.
 * Order follows the input; a package listed twice (same `package`) counts once, so callers can
 * merge lists freely.
 */
export function resolveGrpcPackages(specs: readonly GrpcPackageSpec[]): ResolvedGrpcPackages {
  const byPackage = new Map<string, GrpcPackageSpec>();
  for (const spec of specs) {
    if (!byPackage.has(spec.package)) byPackage.set(spec.package, spec);
  }
  const unique = [...byPackage.values()];
  return {
    packages: unique.map((spec) => spec.package),
    protoPath: [...new Set(unique.flatMap((spec) => spec.protoPath))],
    includeDirs: [...new Set(unique.map((spec) => spec.protoDir))],
    services: unique.flatMap((spec) =>
      spec.services.map((service) => `${spec.package}.${service}`),
    ),
    idempotentMethods: unique.flatMap((spec) =>
      Object.entries(spec.idempotentMethods).flatMap(([service, methods]) =>
        methods.map((method) => ({ service: `${spec.package}.${service}`, method })),
      ),
    ),
  };
}
```

Create `libs/contracts/src/grpc/identity.grpc-package.ts`:

```ts
import { join } from 'node:path';
// Value import on purpose: evaluating the generated module registers ts-proto's
// google.protobuf.Timestamp <-> Date wrapper on the shared protobufjs instance. Every process that
// builds gRPC options for this package loads this file, so Timestamps can never silently decode
// as `{ seconds, nanos }` because a service only imported contract *types*.
import { AUTH_SERVICE_NAME, USERS_SERVICE_NAME } from '../generated/identity/v1/identity.pb.js';
import type { GrpcPackageSpec } from './grpc-package-spec.js';

/** `identity.v1`: AuthService (credential flows) and UsersService (user queries and admin). */
export const IDENTITY_GRPC_PACKAGE: GrpcPackageSpec = {
  package: 'identity.v1',
  // `src/grpc` and `dist/grpc` sit at the same depth and swc `copyFiles` mirrors `src/proto/**`.
  protoDir: join(import.meta.dirname, '..', 'proto'),
  protoPath: ['identity/v1/identity.proto'],
  services: [AUTH_SERVICE_NAME, USERS_SERVICE_NAME],
  clientToken: 'IDENTITY_GRPC_CLIENT',
  // AuthService (Register, Login, RefreshTokens, Logout) is deliberately absent.
  idempotentMethods: { [USERS_SERVICE_NAME]: ['GetUser', 'GetUsersByIds', 'ListUsers'] },
};
```

Create `libs/contracts/src/grpc/billing.grpc-package.ts`:

```ts
import { join } from 'node:path';
// Value import on purpose: registers the Timestamp <-> Date wrapper (see identity.grpc-package.ts).
import { BILLING_SERVICE_NAME } from '../generated/billing/v1/billing.pb.js';
import type { GrpcPackageSpec } from './grpc-package-spec.js';

/** `billing.v1`: BillingService (Stripe Checkout sessions, webhook, payment history). */
export const BILLING_GRPC_PACKAGE: GrpcPackageSpec = {
  package: 'billing.v1',
  protoDir: join(import.meta.dirname, '..', 'proto'),
  protoPath: ['billing/v1/billing.proto'],
  services: [BILLING_SERVICE_NAME],
  clientToken: 'BILLING_GRPC_CLIENT',
  idempotentMethods: { [BILLING_SERVICE_NAME]: ['ListPayments'] },
};
```

Create `libs/contracts/src/grpc/notifications.grpc-package.ts`:

```ts
import { join } from 'node:path';
// Value import on purpose: registers the Timestamp <-> Date wrapper (see identity.grpc-package.ts).
import { NOTIFICATIONS_SERVICE_NAME } from '../generated/notifications/v1/notifications.pb.js';
import type { GrpcPackageSpec } from './grpc-package-spec.js';

/** `notifications.v1`: NotificationsService (inbox listing, mark as read). */
export const NOTIFICATIONS_GRPC_PACKAGE: GrpcPackageSpec = {
  package: 'notifications.v1',
  protoDir: join(import.meta.dirname, '..', 'proto'),
  protoPath: ['notifications/v1/notifications.proto'],
  services: [NOTIFICATIONS_SERVICE_NAME],
  clientToken: 'NOTIFICATIONS_GRPC_CLIENT',
  idempotentMethods: { [NOTIFICATIONS_SERVICE_NAME]: ['ListNotifications'] },
};
```

`libs/contracts/src/index.ts` (lines 12-13), replace:

```ts
 * - Loading this barrel evaluates the generated modules, which registers the protobuf
 *   Timestamp <-> Date wrapper (see grpc/grpc-packages.ts).
```

with:

```ts
 * - Loading this barrel evaluates the generated modules, which registers the protobuf
 *   Timestamp <-> Date wrapper (see grpc/identity.grpc-package.ts).
```

`libs/contracts/src/index.ts` (line 30), replace:

```ts
export * from './grpc/grpc-packages.js';
```

with:

```ts
export * from './grpc/billing.grpc-package.js';
export * from './grpc/grpc-package-spec.js';
export * from './grpc/identity.grpc-package.js';
export * from './grpc/notifications.grpc-package.js';
```

`libs/contracts/package.json` (line 13), replace:

```json
    "./package.json": "./package.json"
```

with:

```json
    "./testing": {
      "@repo/source": "./src/testing/index.ts",
      "types": "./src/testing/index.ts",
      "default": "./dist/testing/index.js"
    },
    "./package.json": "./package.json"
```

`libs/contracts/buf.gen.yaml` (line 4), replace:

```yaml
# These options are mirrored by GRPC_LOADER_OPTIONS (src/grpc/grpc-packages.ts). Change both together:
```

with:

```yaml
# These options are mirrored by GRPC_LOADER_OPTIONS (src/grpc/grpc-package-spec.ts). Change both together:
```

Apply the validated patch with these exact edits (the old -> new snippets are also in `docs/superpowers/plans/2026-10-12-b1-ownership-moves/artifacts/contracts/plan-contracts-lane.md`, contracts-1 Step 3, for hand application):

```bash
git apply --index docs/superpowers/plans/2026-10-12-b1-ownership-moves/artifacts/contracts/patches/contracts-1-step03.patch
```

Expected: applies cleanly and stages exactly: `libs/contracts/src/testing/grpc-wire.ts`, `libs/contracts/src/testing/index.ts`.

- [ ] **Step 4: Run the contracts project**

```bash
npx vitest run --project contracts
```

Expected: PASS (6 files). `@platform/transport` does not compile yet; Step 9 fixes it.


- [ ] **Step 5: Add the transport test fixture (generated with the shared template) and its proto:gen script**

A test-local package `fixture.v1.UsersService` (same shape as a real read/write service, with Timestamps so the Date wrapper is exercised) plus a second, never-generated `echo.v1` package in its own proto root (proves the include-dir merge). The root `proto:gen` now also regenerates the fixture.

Create `libs/transport/test/fixtures/src/proto/fixture/v1/fixture.proto`:

```protobuf
syntax = "proto3";

// Test-only package for the @platform/transport specs, generated with the same ts-proto template
// as the domain contracts packages. Reads are idempotent (retried on UNAVAILABLE); UpdateUserRoles
// is a mutation (never retried).
package fixture.v1;

import "google/protobuf/timestamp.proto";

service UsersService {
  rpc GetUser(GetUserRequest) returns (User);
  rpc GetUsersByIds(GetUsersByIdsRequest) returns (UserList);
  rpc ListUsers(ListUsersRequest) returns (UserPage);
  rpc UpdateUserRoles(UpdateUserRolesRequest) returns (User);
}

message User {
  string id = 1;
  string email = 2;
  string display_name = 3;
  repeated string roles = 4;
  google.protobuf.Timestamp created_at = 5;
  google.protobuf.Timestamp updated_at = 6;
}

message GetUserRequest {
  string id = 1;
}

message GetUsersByIdsRequest {
  repeated string ids = 1;
}

message UserList {
  repeated User users = 1;
}

message ListUsersRequest {
  int32 limit = 1;
  optional string cursor = 2;
}

message UserPage {
  repeated User items = 1;
  optional string next_cursor = 2;
}

message UpdateUserRolesRequest {
  string id = 1;
  repeated string roles = 2;
  string actor_id = 3;
}
```

Create `libs/transport/test/fixtures/echo-proto/echo/v1/echo.proto`:

```protobuf
syntax = "proto3";

// Second test-only package, in its own proto root: proves transport hands every package's
// `protoDir` to proto-loader. Never generated (no TypeScript uses it).
package echo.v1;

service EchoService {
  rpc Echo(EchoRequest) returns (EchoReply);
}

message EchoRequest {
  string text = 1;
}

message EchoReply {
  string text = 1;
}
```

Create `libs/transport/test/fixtures/fixture.grpc-package.ts`:

```ts
import { join } from 'node:path';
import type { GrpcPackageSpec } from '@platform/contracts';
// Value import on purpose: registers the Timestamp <-> Date wrapper, like a contracts package.
import { USERS_SERVICE_NAME } from './src/generated/fixture/v1/fixture.pb.js';

export * from './src/generated/fixture/v1/fixture.pb.js';

/**
 * `fixture.v1.UsersService`, the test-local package of the transport specs (generated by
 * `bun run --filter @platform/transport proto:gen`). Reads are retried, UpdateUserRoles never.
 */
export const FIXTURE_GRPC_PACKAGE: GrpcPackageSpec = {
  package: 'fixture.v1',
  protoDir: join(import.meta.dirname, 'src', 'proto'),
  protoPath: ['fixture/v1/fixture.proto'],
  services: [USERS_SERVICE_NAME],
  clientToken: 'FIXTURE_GRPC_CLIENT',
  idempotentMethods: { [USERS_SERVICE_NAME]: ['GetUser', 'GetUsersByIds', 'ListUsers'] },
};

/** `echo.v1.EchoService`: a second package in its own proto root (options and loading only). */
export const ECHO_GRPC_PACKAGE: GrpcPackageSpec = {
  package: 'echo.v1',
  protoDir: join(import.meta.dirname, 'echo-proto'),
  protoPath: ['echo/v1/echo.proto'],
  services: ['EchoService'],
  clientToken: 'ECHO_GRPC_CLIENT',
  idempotentMethods: { EchoService: ['Echo'] },
};
```

`libs/transport/package.json` (lines 19-20), replace:

```json
    "clean": "rimraf dist coverage"
  },
```

with:

```json
    "clean": "rimraf dist coverage",
    "proto:gen": "cd test/fixtures && buf generate --template ../../../contracts/buf.gen.yaml --config ../../../contracts/buf.yaml && node ../../../contracts/scripts/proto-esm-fix.mjs src/generated"
  },
```

`libs/transport/package.json` (lines 43-46), replace:

```json
  "devDependencies": {
    "@types/lodash-es": "catalog:",
    "@types/opossum": "catalog:"
  }
```

with:

```json
  "devDependencies": {
    "@bufbuild/buf": "catalog:",
    "@types/lodash-es": "catalog:",
    "@types/opossum": "catalog:",
    "protobufjs": "catalog:",
    "ts-proto": "catalog:"
  }
```

`package.json` (line 154), replace:

```json
    "proto:gen": "bun run --filter @platform/contracts proto:gen",
```

with:

```json
    "proto:gen": "bun run --filter @platform/contracts --filter @platform/transport proto:gen",
```


- [ ] **Step 6: Install and generate the fixture code**

```bash
bun install
bun run --filter @platform/transport proto:gen
git status --porcelain -uall -- libs/transport/test/fixtures/src/generated
```

Expected: `proto-esm-fix: patched 1 file(s) in src/generated`, then exactly two `??` lines: `libs/transport/test/fixtures/src/generated/fixture/v1/fixture.pb.ts` and `libs/transport/test/fixtures/src/generated/google/protobuf/timestamp.pb.ts`. `bun.lock` changes only by the three new `@platform/transport` devDependencies.


- [ ] **Step 7: Point the transport gRPC specs at the fixture (failing)**

Every name (`'identity'`, `GRPC_PACKAGES.x`, identity types) becomes a fixture value; client specs pass `{ spec, url }` explicitly, so the `IDENTITY_GRPC_URL` lines go.

Apply the validated patch with these exact edits (the old -> new snippets are also in `docs/superpowers/plans/2026-10-12-b1-ownership-moves/artifacts/contracts/plan-contracts-lane.md`, contracts-1 Step 7, for hand application):

```bash
git apply --index docs/superpowers/plans/2026-10-12-b1-ownership-moves/artifacts/contracts/patches/contracts-1-step07.patch
```

Expected: applies cleanly and stages exactly: `libs/transport/src/grpc/grpc-clients.module.spec.ts`, `libs/transport/src/grpc/grpc-options.spec.ts`, `libs/transport/src/grpc/grpc-retry.spec.ts`, `libs/transport/src/grpc/grpc-roundtrip.spec.ts`, `libs/transport/src/grpc/grpc-tls.spec.ts`, `libs/transport/src/hybrid/connect-microservices.spec.ts`.

- [ ] **Step 8: Run the transport gRPC specs and watch them fail**

```bash
npx vitest run --project transport src/grpc src/hybrid
```

Expected: FAIL, e.g. `TypeError: Cannot read properties of undefined (reading 'map')` from `createGrpcClientOptions` and `Nest could not find FIXTURE_GRPC_CLIENT element` from `GrpcClientsModule.register`.


- [ ] **Step 9: Make the transport gRPC API take values**

`GrpcClientsModule.register({ spec, url }, options?)` registers ONE client (each domain registers its own, as today), `createGrpcClientOptions(cfg, { spec, url }, extras?)`, and the server helpers take `readonly GrpcPackageSpec[]`. The loader gets `includeDirs` from the specs. The server helpers, the hybrid connect helper and a doc comment only change `GrpcPackageName` to `GrpcPackageSpec`.

`libs/transport/src/grpc/grpc-client.options.ts` (lines 6-7), replace:

```ts
  GRPC_PACKAGES,
  type GrpcMethodName,
```

with:

```ts
  type GrpcMethodName,
```

`libs/transport/src/grpc/grpc-client.options.ts` (line 8), replace:

```ts
  type GrpcPackageName,
```

with:

```ts
  type GrpcPackageSpec,
```

`libs/transport/src/grpc/grpc-client.options.ts` (lines 13-14), replace:

```ts
import { createGrpcChannelCredentials } from './grpc-tls.js';

```

with:

```ts
import { createGrpcChannelCredentials } from './grpc-tls.js';

/** The package a client calls and where it dials it. */
export interface GrpcClientTarget {
  /** The package's spec, exported by the owning domain's contracts package. */
  readonly spec: GrpcPackageSpec;
  /** grpc-js target: `host:port`, `dns:///svc.ns.svc.cluster.local:50051`, … */
  readonly url: string;
}

```

`libs/transport/src/grpc/grpc-client.options.ts` (line 21), replace:

```ts
   * only (`GRPC_PACKAGES[name].idempotentMethods`). Default 3; `1` disables retries.
```

with:

```ts
   * only (`spec.idempotentMethods`). Default 3; `1` disables retries.
```

`libs/transport/src/grpc/grpc-client.options.ts` (lines 92-96), replace:

```ts
 * Client `GrpcOptions` for one package: target from `grpcConfig.clients[name]`, the same
 * proto-loader options as the server, message limits, keepalive (detects dead connections behind
 * NATs and load balancers), and the service config above. Resolver-supplied (DNS TXT) service
 * configs are disabled, so the config in code is the only one that applies. With
 * `grpcConfig.tls` the channel uses TLS and presents this process's certificate (mutual TLS).
```

with:

```ts
 * Client `GrpcOptions` for one package: dials `target.url` with the same proto-loader options as
 * the server, message limits, keepalive (detects dead connections behind NATs and load
 * balancers), and the service config above. Resolver-supplied (DNS TXT) service configs are
 * disabled, so the config in code is the only one that applies. With `grpcConfig.tls` the channel
 * uses TLS and presents this process's certificate (mutual TLS).
```

`libs/transport/src/grpc/grpc-client.options.ts` (line 100), replace:

```ts
  name: GrpcPackageName,
```

with:

```ts
  target: GrpcClientTarget,
```

`libs/transport/src/grpc/grpc-client.options.ts` (line 103), replace:

```ts
  const resolved = resolveGrpcPackages([name]);
```

with:

```ts
  const resolved = resolveGrpcPackages([target.spec]);
```

`libs/transport/src/grpc/grpc-client.options.ts` (line 113), replace:

```ts
      url: cfg.clients[name],
```

with:

```ts
      url: target.url,
```

`libs/transport/src/grpc/grpc-client.options.ts` (lines 116-117), replace:

```ts
      protoPath: [...GRPC_PACKAGES[name].protoPath],
      loader: { ...GRPC_LOADER_OPTIONS, includeDirs: [...GRPC_LOADER_OPTIONS.includeDirs] },
```

with:

```ts
      protoPath: resolved.protoPath,
      loader: { ...GRPC_LOADER_OPTIONS, includeDirs: resolved.includeDirs },
```

`libs/transport/src/grpc/grpc-clients.module.ts` (lines 5-7), replace:

```ts
import { GRPC_PACKAGES, type GrpcPackageName } from '@platform/contracts';
import { uniq } from 'lodash-es';
import { GRPC_CIRCUIT_BREAKER_OPTIONS } from './grpc.constants.js';
```

with:

```ts
import { GRPC_CIRCUIT_BREAKER_OPTIONS } from './grpc.constants.js';
```

`libs/transport/src/grpc/grpc-clients.module.ts` (line 9), replace:

```ts
import { createGrpcClientOptions, type GrpcClientOptionsExtras } from './grpc-client.options.js';
```

with:

```ts
import {
  createGrpcClientOptions,
  type GrpcClientOptionsExtras,
  type GrpcClientTarget,
} from './grpc-client.options.js';
```

`libs/transport/src/grpc/grpc-clients.module.ts` (lines 19-21), replace:

```ts
 * Registers one `ClientGrpc` per package under `GRPC_PACKAGES[name].clientToken`
 * (`@Inject(GRPC_PACKAGES.identity.clientToken) client: ClientGrpc`). Clients are configured from
 * `grpcConfig`. Exports:
```

with:

```ts
 * Registers the `ClientGrpc` of one package under `spec.clientToken`
 * (`@Inject(ORDERS_GRPC_PACKAGE.clientToken) client: ClientGrpc`), dialing `url`. Deadline, TLS,
 * message limits and keepalive come from `grpcConfig`. Exports:
```

`libs/transport/src/grpc/grpc-clients.module.ts` (lines 30-33), replace:

```ts
  static register(
    packages: readonly GrpcPackageName[],
    options: GrpcClientsModuleOptions = {},
  ): DynamicModule {
```

with:

```ts
  static register(target: GrpcClientTarget, options: GrpcClientsModuleOptions = {}): DynamicModule {
```

`libs/transport/src/grpc/grpc-clients.module.ts` (lines 35-37), replace:

```ts
    const clients = ClientsModule.registerAsync(
      uniq(packages).map((name) => ({
        name: GRPC_PACKAGES[name].clientToken,
```

with:

```ts
    const clients = ClientsModule.registerAsync([
      {
        name: target.spec.clientToken,
```

`libs/transport/src/grpc/grpc-clients.module.ts` (lines 41-43), replace:

```ts
          createGrpcClientOptions(cfg, name, options.client),
      })),
    );
```

with:

```ts
          createGrpcClientOptions(cfg, target, options.client),
      },
    ]);
```

Apply the validated patch with these exact edits (the old -> new snippets are also in `docs/superpowers/plans/2026-10-12-b1-ownership-moves/artifacts/contracts/plan-contracts-lane.md`, contracts-1 Step 9, for hand application):

```bash
git apply --index docs/superpowers/plans/2026-10-12-b1-ownership-moves/artifacts/contracts/patches/contracts-1-step09.patch
```

Expected: applies cleanly and stages exactly: `libs/transport/src/grpc/grpc-controller.decorator.ts`, `libs/transport/src/grpc/grpc-server.options.ts`, `libs/transport/src/hybrid/connect-microservices.ts`.

- [ ] **Step 10: Run the transport project**

```bash
npx vitest run --project transport
```

Expected: PASS (every file, including the loopback `grpc-roundtrip`, `grpc-retry` and `grpc-tls` specs).


- [ ] **Step 11: Pass values at every domain call site**

The edge modules read their client URL when `forRemote()` is called (`grpcConfig.parse().clients.<x>`, same env var as today). Lane billing later swaps that expression for its per-domain `<x>GrpcClientConfig`; this lane does not touch `libs/config/src/namespaces/grpc.config.ts`. The adapters, the gRPC module comments and the three loopback round-trip specs only swap names for values.

`domains/identity/src/identity-api.module.ts` (lines 1-2), replace:

```ts
import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { GraphqlLoadersModule } from '@platform/graphql';
```

with:

```ts
import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { grpcConfig } from '@platform/config';
import { IDENTITY_GRPC_PACKAGE } from '@platform/contracts';
import { GraphqlLoadersModule } from '@platform/graphql';
```

`domains/identity/src/identity-api.module.ts` (line 37), replace:

```ts
 * - `forRemote()` (gateway): ports → gRPC clients of identity-service (deadline + breaker).
```

with:

```ts
 * - `forRemote()` (gateway): ports → gRPC clients of identity-service (deadline + breaker). The
 *   client URL (`IDENTITY_GRPC_URL`) is read when `forRemote()` is called.
```

`domains/identity/src/identity-api.module.ts` (lines 59-62), replace:

```ts
  static forRemote(options: GrpcClientsModuleOptions = {}): DynamicModule {
    return {
      module: IdentityApiModule,
      imports: [GrpcClientsModule.register(['identity'], options), GraphqlLoadersModule],
```

with:

```ts
  static forRemote(options: GrpcClientsModuleOptions = {}): DynamicModule {
    const target = { spec: IDENTITY_GRPC_PACKAGE, url: grpcConfig.parse().clients.identity };
    return {
      module: IdentityApiModule,
      imports: [GrpcClientsModule.register(target, options), GraphqlLoadersModule],
```

`domains/billing/src/billing-api.module.ts` (lines 1-2), replace:

```ts
import { type DynamicModule, Module, type Provider, type Type } from '@nestjs/common';
import { GrpcClientsModule } from '@platform/transport';
```

with:

```ts
import { type DynamicModule, Module, type Provider, type Type } from '@nestjs/common';
import { grpcConfig } from '@platform/config';
import { BILLING_GRPC_PACKAGE } from '@platform/contracts';
import { GrpcClientsModule } from '@platform/transport';
```

`domains/billing/src/billing-api.module.ts` (lines 41-45), replace:

```ts
  /** Gateway: ports → `billing.v1.BillingService` over gRPC (deadline + circuit breaker). */
  static forRemote(): DynamicModule {
    return {
      module: BillingApiModule,
      imports: [GrpcClientsModule.register(['billing'])],
```

with:

```ts
  /**
   * Gateway: ports → `billing.v1.BillingService` over gRPC (deadline + circuit breaker). The
   * client URL (`BILLING_GRPC_URL`) is read when `forRemote()` is called.
   */
  static forRemote(): DynamicModule {
    const target = { spec: BILLING_GRPC_PACKAGE, url: grpcConfig.parse().clients.billing };
    return {
      module: BillingApiModule,
      imports: [GrpcClientsModule.register(target)],
```

`domains/notifications/src/notifications-api.module.ts` (lines 1-2), replace:

```ts
import { type DynamicModule, Module, type Provider, type Type } from '@nestjs/common';
import { GrpcClientsModule } from '@platform/transport';
```

with:

```ts
import { type DynamicModule, Module, type Provider, type Type } from '@nestjs/common';
import { grpcConfig } from '@platform/config';
import { NOTIFICATIONS_GRPC_PACKAGE } from '@platform/contracts';
import { GrpcClientsModule } from '@platform/transport';
```

`domains/notifications/src/notifications-api.module.ts` (line 23), replace:

```ts
 * - `forRemote()` (gateway): the port calls notifications-service over gRPC.
```

with:

```ts
 * - `forRemote()` (gateway): the port calls notifications-service over gRPC. The client URL
 *   (`NOTIFICATIONS_GRPC_URL`) is read when `forRemote()` is called.
```

`domains/notifications/src/notifications-api.module.ts` (lines 44-47), replace:

```ts
  static forRemote(): DynamicModule {
    return {
      module: NotificationsApiModule,
      imports: [GrpcClientsModule.register(['notifications'])],
```

with:

```ts
  static forRemote(): DynamicModule {
    const target = {
      spec: NOTIFICATIONS_GRPC_PACKAGE,
      url: grpcConfig.parse().clients.notifications,
    };
    return {
      module: NotificationsApiModule,
      imports: [GrpcClientsModule.register(target)],
```

Apply the validated patch with these exact edits (the old -> new snippets are also in `docs/superpowers/plans/2026-10-12-b1-ownership-moves/artifacts/contracts/plan-contracts-lane.md`, contracts-1 Step 11, for hand application):

```bash
git apply --index docs/superpowers/plans/2026-10-12-b1-ownership-moves/artifacts/contracts/patches/contracts-1-step11.patch
```

Expected: applies cleanly and stages exactly: `domains/billing/src/billing-grpc.module.ts`, `domains/billing/src/infrastructure/adapters/grpc/billing-grpc.adapter.ts`, `domains/billing/src/presentation/grpc/billing-grpc.roundtrip.spec.ts`, `domains/identity/src/identity-grpc.module.ts`, `domains/identity/src/infrastructure/adapters/grpc/auth-grpc.adapter.ts`, `domains/identity/src/infrastructure/adapters/grpc/users-grpc.adapter.ts`, `domains/identity/src/presentation/grpc/identity-grpc.roundtrip.spec.ts`, `domains/notifications/src/infrastructure/adapters/grpc/notifications-grpc.adapter.ts`, `domains/notifications/src/notifications-grpc.module.ts`, `domains/notifications/src/presentation/grpc/notifications-grpc.roundtrip.spec.ts`.

- [ ] **Step 12: Pass values in the service apps**

`main.ts` connects `[<X>_GRPC_PACKAGE]`; the test support takes `readonly GrpcPackageSpec[]`; each e2e dials `{ spec: <X>_GRPC_PACKAGE, url: grpcUrl }`.

Apply the validated patch with these exact edits (the old -> new snippets are also in `docs/superpowers/plans/2026-10-12-b1-ownership-moves/artifacts/contracts/plan-contracts-lane.md`, contracts-1 Step 12, for hand application):

```bash
git apply --index docs/superpowers/plans/2026-10-12-b1-ownership-moves/artifacts/contracts/patches/contracts-1-step12.patch
```

Expected: applies cleanly and stages exactly: `apps/billing-service/src/main.ts`, `apps/billing-service/test/app.e2e-spec.ts`, `apps/billing-service/test/support/service-test-app.ts`, `apps/identity-service/src/main.ts`, `apps/identity-service/test/app.e2e-spec.ts`, `apps/identity-service/test/support/service-test-app.ts`, `apps/notifications-service/src/main.ts`, `apps/notifications-service/test/app.e2e-spec.ts`, `apps/notifications-service/test/support/service-test-app.ts`.

- [ ] **Step 13: Run every affected project**

```bash
npx vitest run --project identity --project billing --project notifications \
  --project 'identity-service:e2e' --project 'billing-service:e2e' \
  --project 'notifications-service:e2e' --project 'gateway:e2e' --project 'monolith:e2e'
```

Expected: PASS.


- [ ] **Step 14: Docs and CI drift paths**

The fixture output is generated code, so CI checks it for drift like the contracts. Edit only the `libs/contracts/src/generated` token on these two lines; lane persistence owns the migrations token. Then reformat the transport README tables.

`.github/workflows/ci.yml` (line 80), replace:

```yaml
          git diff --exit-code -- libs/contracts/src/generated libs/database/src/migrations
```

with:

```yaml
          git diff --exit-code -- libs/contracts/src/generated libs/transport/test/fixtures/src/generated libs/database/src/migrations
```

`.github/workflows/ci.yml` (line 81), replace:

```yaml
          test -z "$(git status --porcelain -- libs/contracts/src/generated libs/database/src/migrations)"
```

with:

```yaml
          test -z "$(git status --porcelain -- libs/contracts/src/generated libs/transport/test/fixtures/src/generated libs/database/src/migrations)"
```

Apply the validated patch with these exact edits (the old -> new snippets are also in `docs/superpowers/plans/2026-10-12-b1-ownership-moves/artifacts/contracts/plan-contracts-lane.md`, contracts-1 Step 14, for hand application):

```bash
git apply --index docs/superpowers/plans/2026-10-12-b1-ownership-moves/artifacts/contracts/patches/contracts-1-step14.patch
```

Expected: applies cleanly and stages exactly: `libs/transport/README.md`.

- [ ] **Step 15: Format and run the gate**

```bash
npx prettier --write libs/transport/README.md
bun run check
bun run build
git add libs/transport/test/fixtures
bun run proto:gen
git diff --exit-code -- libs/contracts/src/generated libs/transport/test/fixtures/src/generated
git status --porcelain -uall -- libs/contracts/src/generated libs/transport/test/fixtures/src/generated | grep '^??'
```

Expected: `bun run check` ends with `Layer boundaries OK (24 packages: apps -> domains -> libs).`; the build passes; `git diff` exits 0 and `grep` prints nothing (regenerating reproduces the staged output, as the CI drift step will).


- [ ] **Step 16: Commit**

```bash
git add libs/contracts \
  libs/transport \
  domains/identity/src \
  domains/billing/src \
  domains/notifications/src \
  apps/identity-service \
  apps/billing-service \
  apps/notifications-service \
  package.json \
  bun.lock \
  .github/workflows/ci.yml
git commit -F - <<'EOF'
refactor(contracts,transport): pass gRPC package specs as values

Transport no longer looks gRPC packages up by name in a cross-domain registry.
Each package is a GrpcPackageSpec value (with its own protoDir), and
GrpcClientsModule.register({ spec, url }), createGrpcClientOptions(cfg, { spec, url })
and the server helpers take those values. Platform specs run against a
test-local fixture package generated with the shared ts-proto template.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```


### Task contracts-2: Kafka events as values (`EventContract`)

**Files:**
- Move: `libs/contracts/src/events/event-registry.ts` -> `libs/contracts/src/events/event-contract.ts`
- Create: `libs/transport/test/fixtures/fixture.events.ts`
- Modify: `libs/contracts/src/events/topics.spec.ts` (whole file)
- Modify: `libs/contracts/src/events/event-contract.ts` (whole file)
- Modify: `libs/contracts/src/events/topics.ts` (whole file)
- Modify: `libs/contracts/src/events/envelope.ts:5`
- Modify: `libs/contracts/src/events/identity.events.ts:1-2,12`
- Modify: `libs/contracts/src/events/billing.events.ts:1-2,15`
- Modify: `libs/contracts/src/events/notifications.events.ts:1-2,19`
- Modify: `libs/contracts/src/index.ts:18`
- Modify: `libs/transport/src/kafka/kafka-event-pattern.decorator.ts` (whole file)
- Modify: `libs/transport/src/kafka/parse-event-envelope.pipe.ts:3-5,12,16-17,25-26,27-28,30-33,36-37`
- Modify: `domains/notifications/src/domain/notification.types.ts:2-4`
- Modify: `scripts/docker/check-kafka-topics.mjs` (whole file)
- Modify: `libs/transport/scripts/kafka-dlq-replay.mjs:4,12,25,27`
- Modify: `docker/kafka/topics.txt:2`
- Delete: `libs/contracts/src/events/event-registry.spec.ts`
- Create/Modify (exact edits in patch `contracts-2-step01.patch`): `libs/contracts/src/events/event-contract.spec.ts`, `libs/contracts/src/events/identity.events.spec.ts`, `libs/contracts/src/events/billing.events.spec.ts`, `libs/contracts/src/events/notifications.events.spec.ts`
- Create/Modify (exact edits in patch `contracts-2-step05.patch`): `libs/transport/src/kafka/kafka-decorators.spec.ts`, `libs/transport/src/kafka/parse-event-envelope.pipe.spec.ts`, `libs/transport/src/kafka/kafka-producer.service.spec.ts`, `libs/transport/src/kafka/kafka-producer.module.spec.ts`
- Create/Modify (exact edits in patch `contracts-2-step07.patch`): `libs/transport/src/kafka/kafka-producer.service.ts`, `libs/transport/src/kafka/testing/fake-kafka-producer.ts`
- Create/Modify (exact edits in patch `contracts-2-step12.patch`): `libs/transport/README.md`
- Test: `npx vitest run --project contracts`
- Test: `npx vitest run --project transport`
- Test: `identity`, `billing`, `notifications`, the five `<app>:e2e` projects
- Test: `node scripts/docker/check-kafka-topics.mjs` (after `bun run build`)

**Interfaces:**
- Consumes: Task contracts-1 (same files, nothing else).
- Produces (`@platform/contracts`): `interface EventContract<TPayload> { readonly topic: string; readonly payload: z.ZodType<TPayload> }`; `defineEventContract<TPayload>(topic: string, payload: z.ZodType<TPayload>): EventContract<TPayload>`; `isEventContract(value: unknown): value is EventContract<unknown>`; `EventPayloadOf<C>`; `EventEnvelopeOf<C>`; `eventEnvelopeSchemaFor(contract)`; `parseEventEnvelope<TPayload>(contract, raw): EventEnvelope<TPayload>`; `safeParseEventEnvelope(contract, raw)`; `createEventEnvelope<TPayload>(contract, payload: NoInfer<TPayload>, meta: EventEnvelopeMeta): EventEnvelope<TPayload>`; `EVENT_TOPIC_PATTERN`; `isEventTopic(value): value is string`; `deadLetterTopic<T extends string>(topic: T): DeadLetterTopic<T>`; `type DeadLetterTopic<T extends string = string> = \`${T}.dlq\``; `topicVersion(topic: string): number`. Unchanged: `eventEnvelopeSchema`, `EventEnvelope<T>`, `EventEnvelopeSchema<T>`, `KAFKA_HEADERS`. Removed: `KAFKA_TOPICS`, `KafkaTopic`, `KAFKA_TOPIC_VALUES`, `DEAD_LETTER_TOPIC_VALUES`, `isKafkaTopic`, `EVENT_PAYLOAD_SCHEMAS`, `EVENT_ENVELOPE_SCHEMAS`, `EventPayload`, `EventEnvelopeFor`.
- Produces (event contracts, in `@platform/contracts` until Task contracts-3): `USER_REGISTERED_EVENT: EventContract<UserRegisteredPayload>`, `PAYMENT_SUCCEEDED_EVENT: EventContract<PaymentSucceededPayload>`, `NOTIFICATION_CREATED_EVENT: EventContract<NotificationCreatedPayload>`, plus the unchanged `userRegisteredPayload`, `paymentSucceededPayload`, `notificationCreatedPayload`, their types, `NOTIFICATION_TYPES`, `NotificationType`. Topic names unchanged.
- Produces (`@platform/transport`): `KafkaEventPattern(contract: EventContract<unknown>, options?: KafkaEventPatternOptions /* { deadLetter?: boolean } */): MethodDecorator`; `new ParseEventEnvelopePipe<TPayload>(contract: EventContract<TPayload>)` (a `PipeTransform<unknown, EventEnvelope<TPayload>>`); `KafkaProducer.publish<TPayload>(contract: EventContract<TPayload>, payload: NoInfer<TPayload>, options?: KafkaPublishOptions): Promise<EventEnvelope<TPayload>>` (and `createEnvelope` / `createRecord` with the same parameters; the class keeps its name `KafkaProducer` in `kafka-producer.service.ts`); `KafkaOutgoingRecord<TPayload = unknown>`; `FakeKafkaProducer.published<TPayload>(contract?: EventContract<TPayload>)`, `.envelopes<TPayload>(contract: EventContract<TPayload>)`; `PublishedKafkaRecord<TPayload = unknown>` (`topic: string`). Fixtures: `libs/transport/test/fixtures/fixture.events.ts` (`FIXTURE_USER_REGISTERED_EVENT`, `FIXTURE_PAYMENT_SUCCEEDED_EVENT`).

- [ ] **Step 1: Write the failing event-contract specs**

The aggregate registry spec becomes a generic `EventContract` spec over a test-local `orders.order-placed.v1` contract; `topics.spec.ts` tests only the generic helpers; each domain event gets a spec that later moves with it.

```bash
git rm libs/contracts/src/events/event-registry.spec.ts
```

Replace the whole content of `libs/contracts/src/events/topics.spec.ts`:

```ts
import { describe, expect, expectTypeOf, it } from 'vitest';
import { type DeadLetterTopic, deadLetterTopic, isEventTopic, topicVersion } from './topics.js';

describe('isEventTopic', () => {
  it.each(['orders.order-placed.v1', 'orders.placed.v12'])('accepts %s', (topic) => {
    expect(isEventTopic(topic)).toBe(true);
  });

  it.each([
    'orders.order-placed',
    'orders.order-placed.v1.dlq',
    'Orders.order-placed.v1',
    'orders.order_placed.v1',
    undefined,
    42,
  ])('rejects %s', (value) => {
    expect(isEventTopic(value)).toBe(false);
  });
});

describe('deadLetterTopic', () => {
  it('appends .dlq with a literal type', () => {
    const dlq = deadLetterTopic('orders.order-placed.v1');
    expect(dlq).toBe('orders.order-placed.v1.dlq');
    expectTypeOf(dlq).toEqualTypeOf<'orders.order-placed.v1.dlq'>();
    expectTypeOf(dlq).toExtend<DeadLetterTopic>();
  });
});

describe('topicVersion', () => {
  it('reads the major version from the topic suffix', () => {
    expect(topicVersion('orders.order-placed.v1')).toBe(1);
    expect(topicVersion('orders.order-placed.v12')).toBe(12);
  });

  it('throws for a topic without a version suffix', () => {
    expect(() => topicVersion('orders.order-placed')).toThrow(/no "\.v<major>" suffix/);
  });
});
```

Apply the validated patch with these exact edits (the old -> new snippets are also in `docs/superpowers/plans/2026-10-12-b1-ownership-moves/artifacts/contracts/plan-contracts-lane.md`, contracts-2 Step 1, for hand application):

```bash
git apply --index docs/superpowers/plans/2026-10-12-b1-ownership-moves/artifacts/contracts/patches/contracts-2-step01.patch
```

Expected: applies cleanly and stages exactly: `libs/contracts/src/events/billing.events.spec.ts`, `libs/contracts/src/events/event-contract.spec.ts`, `libs/contracts/src/events/identity.events.spec.ts`, `libs/contracts/src/events/notifications.events.spec.ts`.

- [ ] **Step 2: Run the contracts project and watch it fail**

```bash
npx vitest run --project contracts
```

Expected: FAIL: `Error: Cannot find module './event-contract.js'` and `TypeError: Cannot read properties of undefined (reading 'topic')` in the three `*.events.spec.ts`.


- [ ] **Step 3: Implement EventContract, the generic helpers and the three event contracts**

Envelope schemas are built once per contract object (`WeakMap`), so a plain `{ topic, payload }` literal from another lane works too. `defineEventContract` freezes the contract and rejects a malformed topic at module load. The contracts stay in `libs/contracts/src/events/` until Task contracts-3.

```bash
git mv libs/contracts/src/events/event-registry.ts libs/contracts/src/events/event-contract.ts
```

Replace the whole content of `libs/contracts/src/events/event-contract.ts`:

```ts
import type { z } from 'zod';
import { type EventEnvelope, type EventEnvelopeSchema, eventEnvelopeSchema } from './envelope.js';
import { EVENT_TOPIC_PATTERN, isEventTopic, topicVersion } from './topics.js';

/**
 * One integration event: its Kafka topic and its payload schema. The producing domain's contracts
 * package exports one per topic (`<EVENT>_EVENT`); transport, producers and consumers only ever
 * take these values, never a topic name.
 */
export interface EventContract<TPayload> {
  /** `<context>.<event-name>.v<major>`; also the envelope `type`. */
  readonly topic: string;
  /** Payload schema: a tolerant reader (unknown keys are stripped, not rejected). */
  readonly payload: z.ZodType<TPayload>;
}

/** Payload type carried by an event contract. */
export type EventPayloadOf<C> = C extends EventContract<infer TPayload> ? TPayload : never;

/** Envelope type carried by an event contract. */
export type EventEnvelopeOf<C> = EventEnvelope<EventPayloadOf<C>>;

/**
 * A frozen event contract. Fails at module load when `topic` breaks the
 * `<context>.<event-name>.v<major>` convention, so a typo never reaches a broker.
 */
export function defineEventContract<TPayload>(
  topic: string,
  payload: z.ZodType<TPayload>,
): EventContract<TPayload> {
  if (!EVENT_TOPIC_PATTERN.test(topic)) {
    throw new Error(`Kafka topic "${topic}" must be named <context>.<event-name>.v<major>`);
  }
  return Object.freeze({ topic, payload });
}

/** Narrows an unknown value (scripts scan whole module namespaces) to an event contract. */
export function isEventContract(value: unknown): value is EventContract<unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const { topic, payload } = value as { topic?: unknown; payload?: { safeParse?: unknown } };
  return isEventTopic(topic) && typeof payload?.safeParse === 'function';
}

const envelopeSchemas = new WeakMap<EventContract<unknown>, z.ZodType>();

/**
 * The envelope schema of `contract`, built on first use and cached per contract object: zod
 * object construction is far more expensive than parsing, so hot paths only ever call `.parse()`.
 */
export function eventEnvelopeSchemaFor<TPayload>(
  contract: EventContract<TPayload>,
): EventEnvelopeSchema<z.ZodType<TPayload>> {
  let schema = envelopeSchemas.get(contract);
  if (schema === undefined) {
    schema = eventEnvelopeSchema(contract.payload);
    envelopeSchemas.set(contract, schema);
  }
  return schema as EventEnvelopeSchema<z.ZodType<TPayload>>;
}

/**
 * Validates a deserialised Kafka message value against the envelope and payload schema of
 * `contract`. Throws `ZodError` on invalid input (transport maps it to its invalid-event
 * exception).
 */
export function parseEventEnvelope<TPayload>(
  contract: EventContract<TPayload>,
  raw: unknown,
): EventEnvelope<TPayload> {
  return eventEnvelopeSchemaFor(contract).parse(raw);
}

/** Non-throwing variant of {@link parseEventEnvelope}. */
export function safeParseEventEnvelope<TPayload>(
  contract: EventContract<TPayload>,
  raw: unknown,
): z.ZodSafeParseResult<EventEnvelope<TPayload>> {
  return eventEnvelopeSchemaFor(contract).safeParse(raw);
}

/** Producer-side metadata for {@link createEventEnvelope}. */
export interface EventEnvelopeMeta {
  /** uuidv7 event id (time-ordered; consumers dedupe on it). */
  id: string;
  /** Producing service name. */
  source: string;
  correlationId?: string | undefined;
  /** Defaults to now. */
  occurredAt?: Date | undefined;
}

/**
 * Builds AND validates the envelope of `contract` (type = topic, version = topic major), so an
 * invalid payload fails in the producer instead of poisoning every consumer's dead-letter topic.
 */
export function createEventEnvelope<TPayload>(
  contract: EventContract<TPayload>,
  payload: NoInfer<TPayload>,
  meta: EventEnvelopeMeta,
): EventEnvelope<TPayload> {
  return parseEventEnvelope(contract, {
    id: meta.id,
    type: contract.topic,
    version: topicVersion(contract.topic),
    occurredAt: (meta.occurredAt ?? new Date()).toISOString(),
    source: meta.source,
    ...(meta.correlationId === undefined ? {} : { correlationId: meta.correlationId }),
    payload,
  });
}
```

Replace the whole content of `libs/contracts/src/events/topics.ts`:

```ts
/**
 * Kafka topics carrying integration events are named `<context>.<event-name>.v<major>`. A
 * breaking payload change ships as a NEW topic (`.v2`) consumed side by side; additive changes
 * stay on the same topic because payload schemas are tolerant readers (unknown keys are
 * stripped, not rejected).
 */
export const EVENT_TOPIC_PATTERN = /^[a-z]+\.[a-z]+(?:-[a-z]+)*\.v\d+$/;

/** Narrows an untrusted value (a CLI argument, `KafkaContext.getTopic()`) to a topic name. */
export function isEventTopic(value: unknown): value is string {
  return typeof value === 'string' && EVENT_TOPIC_PATTERN.test(value);
}

/** Dead-letter twin of a topic: poison messages land there instead of blocking the partition. */
export type DeadLetterTopic<T extends string = string> = `${T}.dlq`;

/** `orders.order-placed.v1` -> `orders.order-placed.v1.dlq`. */
export const deadLetterTopic = <T extends string>(topic: T): DeadLetterTopic<T> => `${topic}.dlq`;

/**
 * Major schema version encoded in the topic name (`….v1` -> 1); producers stamp it on the
 * envelope so consumers can assert what they parse.
 */
export function topicVersion(topic: string): number {
  const match = /\.v(\d+)$/.exec(topic);
  if (!match?.[1]) {
    throw new Error(`Kafka topic "${topic}" has no ".v<major>" suffix`);
  }
  return Number(match[1]);
}
```

`libs/contracts/src/events/envelope.ts` (line 5), replace:

```ts
 * topic's envelope schema is built ONCE at module load (see event-registry.ts) — never per message.
```

with:

```ts
 * contract's envelope schema is built ONCE (see `eventEnvelopeSchemaFor`) — never per message.
```

`libs/contracts/src/events/identity.events.ts` (lines 1-2), replace:

```ts
import { z } from 'zod';

```

with:

```ts
import { z } from 'zod';
import { defineEventContract, type EventContract } from './event-contract.js';

```

`libs/contracts/src/events/identity.events.ts` (line 12), replace:

```ts
export type UserRegisteredPayload = z.infer<typeof userRegisteredPayload>;
```

with:

```ts
export type UserRegisteredPayload = z.infer<typeof userRegisteredPayload>;

/** A user account was created. Produced by identity; notifications sends the welcome mail. */
export const USER_REGISTERED_EVENT: EventContract<UserRegisteredPayload> = defineEventContract(
  'identity.user-registered.v1',
  userRegisteredPayload,
);
```

`libs/contracts/src/events/billing.events.ts` (lines 1-2), replace:

```ts
import { z } from 'zod';

```

with:

```ts
import { z } from 'zod';
import { defineEventContract, type EventContract } from './event-contract.js';

```

`libs/contracts/src/events/billing.events.ts` (line 15), replace:

```ts
export type PaymentSucceededPayload = z.infer<typeof paymentSucceededPayload>;
```

with:

```ts
export type PaymentSucceededPayload = z.infer<typeof paymentSucceededPayload>;

/** A Checkout Session was paid. Produced by billing; notifications sends the receipt. */
export const PAYMENT_SUCCEEDED_EVENT: EventContract<PaymentSucceededPayload> = defineEventContract(
  'billing.payment-succeeded.v1',
  paymentSucceededPayload,
);
```

`libs/contracts/src/events/notifications.events.ts` (lines 1-2), replace:

```ts
import { z } from 'zod';

```

with:

```ts
import { z } from 'zod';
import { defineEventContract, type EventContract } from './event-contract.js';

```

`libs/contracts/src/events/notifications.events.ts` (line 19), replace:

```ts
export type NotificationCreatedPayload = z.infer<typeof notificationCreatedPayload>;
```

with:

```ts
export type NotificationCreatedPayload = z.infer<typeof notificationCreatedPayload>;

/** An inbox entry was stored. Produced by notifications; the edges push it to sockets. */
export const NOTIFICATION_CREATED_EVENT: EventContract<NotificationCreatedPayload> =
  defineEventContract('notifications.notification-created.v1', notificationCreatedPayload);
```

`libs/contracts/src/index.ts` (line 18), replace:

```ts
export * from './events/event-registry.js';
```

with:

```ts
export * from './events/event-contract.js';
```


- [ ] **Step 4: Run the contracts project**

```bash
npx vitest run --project contracts
```

Expected: PASS.


- [ ] **Step 5: Point the transport Kafka specs at fixture contracts (failing)**

Two test-local contracts (`fixture.user-registered.v1`, `fixture.payment-succeeded.v1`) replace the domain topics. The dead-letter subscription is now `@KafkaEventPattern(contract, { deadLetter: true })`.

Create `libs/transport/test/fixtures/fixture.events.ts`:

```ts
import { defineEventContract, type EventContract } from '@platform/contracts';
import { z } from 'zod';

/** Test-local event contracts of the @platform/transport Kafka specs. */
export const fixtureUserRegisteredPayload = z.object({
  userId: z.uuid(),
  email: z.email(),
  displayName: z.string(),
  registeredAt: z.iso.datetime(),
});
export type FixtureUserRegisteredPayload = z.infer<typeof fixtureUserRegisteredPayload>;

export const FIXTURE_USER_REGISTERED_EVENT: EventContract<FixtureUserRegisteredPayload> =
  defineEventContract('fixture.user-registered.v1', fixtureUserRegisteredPayload);

export const fixturePaymentSucceededPayload = z.object({
  paymentId: z.uuid(),
  userId: z.uuid(),
  amountTotal: z.number().int().nonnegative(),
  currency: z.string().length(3),
  paidAt: z.iso.datetime(),
});
export type FixturePaymentSucceededPayload = z.infer<typeof fixturePaymentSucceededPayload>;

export const FIXTURE_PAYMENT_SUCCEEDED_EVENT: EventContract<FixturePaymentSucceededPayload> =
  defineEventContract('fixture.payment-succeeded.v1', fixturePaymentSucceededPayload);
```

Apply the validated patch with these exact edits (the old -> new snippets are also in `docs/superpowers/plans/2026-10-12-b1-ownership-moves/artifacts/contracts/plan-contracts-lane.md`, contracts-2 Step 5, for hand application):

```bash
git apply --index docs/superpowers/plans/2026-10-12-b1-ownership-moves/artifacts/contracts/patches/contracts-2-step05.patch
```

Expected: applies cleanly and stages exactly: `libs/transport/src/kafka/kafka-decorators.spec.ts`, `libs/transport/src/kafka/kafka-producer.module.spec.ts`, `libs/transport/src/kafka/kafka-producer.service.spec.ts`, `libs/transport/src/kafka/parse-event-envelope.pipe.spec.ts`.

- [ ] **Step 6: Run the transport Kafka specs and watch them fail**

```bash
npx vitest run --project transport src/kafka
```

Expected: FAIL: `TypeError: isKafkaTopic is not a function` (pipe spec), and `AssertionError: expected [ { …(2) } ] to deeply equal [ 'fixture.user-registered.v1' ]` (decorator spec).


- [ ] **Step 7: Make the transport Kafka API take contracts**

Every method takes the contract; the payload parameter is `NoInfer<TPayload>`, so a payload is checked against the contract instead of widening it. `KafkaProducer` and `FakeKafkaProducer` swap `T extends KafkaTopic` for `TPayload`, take `contract` where they took `topic`, and dispatch to `contract.topic` (see Interfaces).

Replace the whole content of `libs/transport/src/kafka/kafka-event-pattern.decorator.ts`:

```ts
import { EventPattern, Transport } from '@nestjs/microservices';
import { deadLetterTopic, type EventContract } from '@platform/contracts';

/** Options of {@link KafkaEventPattern}. */
export interface KafkaEventPatternOptions {
  /**
   * Subscribe to the contract's dead-letter twin (`<topic>.dlq`) instead, e.g. for a replay or
   * quarantine consumer. Records there still carry the source topic's envelope.
   */
  deadLetter?: boolean;
}

/**
 * `@EventPattern` for the topic of an integration-event contract. Use it instead of
 * `@EventPattern(topic)`:
 * - The explicit `<string>` type argument is required in Nest 12.1: a bare
 *   `@EventPattern('topic')` picks the new typed overload, whose descriptor type rejects a
 *   typed `@Ctx() ctx: KafkaContext` parameter with TS1241 (nest-distributed §5.4).
 * - `Transport.KAFKA` binds the handler to the Kafka server only, so a hybrid app's gRPC server
 *   does not try to register it.
 * - Taking the contract (exported by the producer's contracts package) instead of a string keeps
 *   the topic name in one place and makes a typo impossible.
 */
export const KafkaEventPattern = (
  contract: EventContract<unknown>,
  options: KafkaEventPatternOptions = {},
): MethodDecorator =>
  EventPattern<string>(
    options.deadLetter === true ? deadLetterTopic(contract.topic) : contract.topic,
    Transport.KAFKA,
  );
```

`libs/transport/src/kafka/parse-event-envelope.pipe.ts` (lines 3-5), replace:

```ts
  type EventEnvelopeFor,
  isKafkaTopic,
  type KafkaTopic,
```

with:

```ts
  type EventContract,
  type EventEnvelope,
  eventEnvelopeSchemaFor,
```

`libs/transport/src/kafka/parse-event-envelope.pipe.ts` (line 12), replace:

```ts
 * Validates a Kafka payload against the envelope + payload schema of `topic` and returns the
```

with:

```ts
 * Validates a Kafka payload against the envelope + payload schema of `contract` and returns the
```

`libs/transport/src/kafka/parse-event-envelope.pipe.ts` (lines 16-17), replace:

```ts
 * @KafkaEventPattern(KAFKA_TOPICS.USER_REGISTERED)
 * onUserRegistered(@Payload(new ParseEventEnvelopePipe(KAFKA_TOPICS.USER_REGISTERED)) event: EventEnvelopeFor<'identity.user-registered.v1'>)
```

with:

```ts
 * @KafkaEventPattern(ORDER_PLACED_EVENT)
 * onOrderPlaced(@Payload(new ParseEventEnvelopePipe(ORDER_PLACED_EVENT)) event: EventEnvelopeOf<typeof ORDER_PLACED_EVENT>)
```

`libs/transport/src/kafka/parse-event-envelope.pipe.ts` (lines 25-26), replace:

```ts
export class ParseEventEnvelopePipe<T extends KafkaTopic>
  implements PipeTransform<unknown, EventEnvelopeFor<T>>
```

with:

```ts
export class ParseEventEnvelopePipe<TPayload>
  implements PipeTransform<unknown, EventEnvelope<TPayload>>
```

`libs/transport/src/kafka/parse-event-envelope.pipe.ts` (lines 27-28), replace:

```ts
{
  private readonly version: number;
```

with:

```ts
{
  private readonly topic: string;
  private readonly version: number;
```

`libs/transport/src/kafka/parse-event-envelope.pipe.ts` (lines 30-33), replace:

```ts
  constructor(private readonly topic: T) {
    // Fail at bootstrap (decorator evaluation), not on the first message.
    if (!isKafkaTopic(topic)) throw new Error(`Unknown Kafka topic "${String(topic)}"`);
    this.version = topicVersion(topic);
```

with:

```ts
  constructor(private readonly contract: EventContract<TPayload>) {
    // Fail at bootstrap (decorator evaluation), not on the first message: a topic without a
    // `.v<major>` suffix throws here, and the envelope schema is built once, now.
    this.topic = contract.topic;
    this.version = topicVersion(contract.topic);
    eventEnvelopeSchemaFor(contract);
```

`libs/transport/src/kafka/parse-event-envelope.pipe.ts` (lines 36-37), replace:

```ts
  transform(value: unknown): EventEnvelopeFor<T> {
    const result = safeParseEventEnvelope(this.topic, value);
```

with:

```ts
  transform(value: unknown): EventEnvelope<TPayload> {
    const result = safeParseEventEnvelope(this.contract, value);
```

Apply the validated patch with these exact edits (the old -> new snippets are also in `docs/superpowers/plans/2026-10-12-b1-ownership-moves/artifacts/contracts/plan-contracts-lane.md`, contracts-2 Step 7, for hand application):

```bash
git apply --index docs/superpowers/plans/2026-10-12-b1-ownership-moves/artifacts/contracts/patches/contracts-2-step07.patch
```

Expected: applies cleanly and stages exactly: `libs/transport/src/kafka/kafka-producer.service.ts`, `libs/transport/src/kafka/testing/fake-kafka-producer.ts`.

- [ ] **Step 8: Run the transport project**

```bash
npx vitest run --project transport
```

Expected: PASS.


- [ ] **Step 9: Rewrite the domain and app call sites with a codemod**

The codemod is saved at `docs/superpowers/plans/2026-10-12-b1-ownership-moves/artifacts/contracts/codemods/b1-kafka-contracts-codemod.mjs` (not committed). It rewrites contract positions (`published`/`envelopes`/`publish`/`createEventEnvelope`/`parseEventEnvelope`/`KafkaEventPattern`/`ParseEventEnvelopePipe` arguments) to the `<X>_EVENT` contract, `EventEnvelopeFor<typeof KAFKA_TOPICS.X>` to `EventEnvelopeOf<typeof X_EVENT>`, every other `KAFKA_TOPICS.X` to `X_EVENT.topic`, and the `KAFKA_TOPICS` import specifier to the contracts the file uses. Copy it:

```bash
cp docs/superpowers/plans/2026-10-12-b1-ownership-moves/artifacts/contracts/codemods/b1-kafka-contracts-codemod.mjs "$TMPDIR/"
```

Run it on every file that still names the old aggregates, then let Biome sort the rewritten import lists:

```bash
git grep -lE "KAFKA_TOPICS|EventEnvelopeFor" -- 'apps/**/*.ts' 'domains/**/*.ts' > "$TMPDIR/b1-kafka-importers.txt"
node "$TMPDIR/b1-kafka-contracts-codemod.mjs" $(cat "$TMPDIR/b1-kafka-importers.txt")
npx biome check --write $(cat "$TMPDIR/b1-kafka-importers.txt")
git grep -nE "KAFKA_TOPICS|EventEnvelopeFor" -- apps domains
```

Expected: at HEAD 74f70b7 the list holds these 17 files, each reported as `rewrote <file>`: `apps/monolith/test/app.e2e-spec.ts`, `apps/notifications-service/test/app.e2e-spec.ts`, `domains/billing/src/application/relays/payment-succeeded.relay.spec.ts`, `domains/billing/src/application/relays/payment-succeeded.relay.ts`, `domains/billing/test/stripe-webhook.flow.spec.ts`, `domains/identity/src/application/event-handlers/user-registered.relay.spec.ts`, `domains/identity/src/application/event-handlers/user-registered.relay.ts`, `domains/identity/src/identity-api.module.spec.ts`, `domains/notifications/src/application/commands/publish-notification-created/publish-notification-created.handler.spec.ts`, `domains/notifications/src/application/commands/publish-notification-created/publish-notification-created.handler.ts`, `domains/notifications/src/application/mappers/notification.mapper.spec.ts`, `domains/notifications/src/notifications.modules.spec.ts`, `domains/notifications/src/presentation/messaging/billing-events.consumer.ts`, `domains/notifications/src/presentation/messaging/identity-events.consumer.ts`, `domains/notifications/src/presentation/messaging/notification-push.consumer.spec.ts`, `domains/notifications/src/presentation/messaging/notification-push.consumer.ts`, `domains/notifications/src/presentation/messaging/notifications-events.consumers.spec.ts`. Biome exits 0 and the last `git grep` prints nothing. Then update the comment that named the old package:

`domains/notifications/src/domain/notification.types.ts` (lines 2-4), replace:

```ts
 * Notification kinds. The same list as `NOTIFICATION_TYPES` in `@platform/contracts` (the Kafka
 * `notification-created` payload); the mapper asserts both stay equal at compile time. The domain
 * keeps its own copy because it must not depend on wire contracts.
```

with:

```ts
 * Notification kinds. The same list as `NOTIFICATION_TYPES` in the notifications contracts (the
 * Kafka `notification-created` payload); the mapper asserts both stay equal at compile time. The
 * domain keeps its own copy because it must not depend on wire contracts.
```


- [ ] **Step 10: Run every affected project**

```bash
npx vitest run --project identity --project billing --project notifications \
  --project 'identity-service:e2e' --project 'billing-service:e2e' \
  --project 'notifications-service:e2e' --project 'gateway:e2e' --project 'monolith:e2e'
```

Expected: PASS.


- [ ] **Step 11: Scripts and the topic list**

`check-kafka-topics.mjs` now derives the expected topics from every exported event contract (`isEventContract`) instead of the deleted aggregates. The DLQ replay CLI is a platform script, so it must not import a domain: it validates the topic by its shape.

Replace the whole content of `scripts/docker/check-kafka-topics.mjs`:

```js
// Fails when docker/kafka/topics.txt drifts from the Kafka contracts: it must provision exactly the
// topic of every exported event contract (`<EVENT>_EVENT`) plus its `.dlq` twin (broker
// auto-creation is off, so a missing topic makes consumers fail at boot). Needs the built
// contracts (`bun run build`):
//   node scripts/docker/check-kafka-topics.mjs
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as contracts from '@platform/contracts';

const { deadLetterTopic, isEventContract } = contracts;
const topics = Object.values(contracts)
  .filter(isEventContract)
  .map((contract) => contract.topic);

const file = join(import.meta.dirname, '..', '..', 'docker', 'kafka', 'topics.txt');
const provisioned = readFileSync(file, 'utf8')
  .split('\n')
  .map((line) => line.replace(/#.*/, '').trim())
  .filter(Boolean)
  .map((line) => line.split(':')[0]);

const expected = [...topics, ...topics.map((topic) => deadLetterTopic(topic))];
const missing = expected.filter((topic) => !provisioned.includes(topic));
const extra = provisioned.filter((topic) => !expected.includes(topic));
const duplicated = provisioned.filter((topic, i) => provisioned.indexOf(topic) !== i);

for (const topic of missing) console.error(`topics.txt is missing ${topic}`);
for (const topic of extra)
  console.error(`topics.txt provisions ${topic}, which no event contract uses`);
for (const topic of duplicated) console.error(`topics.txt lists ${topic} twice`);
if (missing.length + extra.length + duplicated.length > 0) process.exit(1);
console.info(`docker/kafka/topics.txt provisions all ${expected.length} contract topics`);
```

`libs/transport/scripts/kafka-dlq-replay.mjs` (line 4), replace:

```js
// <topic> is the SOURCE topic (e.g. identity.user-registered.v1); `<topic>.dlq` is read. Broker
```

with:

```js
// <topic> is the SOURCE topic (`<context>.<event-name>.v<major>`); `<topic>.dlq` is read. Broker
```

`libs/transport/scripts/kafka-dlq-replay.mjs` (line 12), replace:

```js
import { isKafkaTopic, KAFKA_TOPIC_VALUES } from '@platform/contracts';
```

with:

```js
import { isEventTopic } from '@platform/contracts';
```

`libs/transport/scripts/kafka-dlq-replay.mjs` (line 25), replace:

```js
if (!isKafkaTopic(topic)) {
```

with:

```js
if (!isEventTopic(topic)) {
```

`libs/transport/scripts/kafka-dlq-replay.mjs` (line 27), replace:

```js
    `usage: kafka-dlq-replay.mjs <topic> [--dry-run] [--group <id>]\n  <topic>: ${KAFKA_TOPIC_VALUES.join(' | ')}\n`,
```

with:

```js
    'usage: kafka-dlq-replay.mjs <topic> [--dry-run] [--group <id>]\n' +
      '  <topic>: a source topic, <context>.<event-name>.v<major> (docker/kafka/topics.txt)\n',
```

`docker/kafka/topics.txt` (line 2), replace:

```text
# Source of truth: @platform/contracts KAFKA_TOPIC_VALUES + DEAD_LETTER_TOPIC_VALUES
```

with:

```text
# Source of truth: the topic of every exported event contract (<EVENT>_EVENT) plus its .dlq twin
```


- [ ] **Step 12: Transport README**

Apply the validated patch with these exact edits (the old -> new snippets are also in `docs/superpowers/plans/2026-10-12-b1-ownership-moves/artifacts/contracts/plan-contracts-lane.md`, contracts-2 Step 12, for hand application):

```bash
git apply --index docs/superpowers/plans/2026-10-12-b1-ownership-moves/artifacts/contracts/patches/contracts-2-step12.patch
```

Expected: applies cleanly and stages exactly: `libs/transport/README.md`.

- [ ] **Step 13: Format and run the gate**

```bash
npx prettier --write libs/transport/README.md
bun run check
bun run build
node scripts/docker/check-kafka-topics.mjs
```

Expected: check and build pass; the last command prints `docker/kafka/topics.txt provisions all 6 contract topics`.


- [ ] **Step 14: Commit**

```bash
git add libs/contracts \
  libs/transport \
  domains/identity/src \
  domains/billing/src \
  domains/billing/test \
  domains/notifications/src \
  apps/monolith/test \
  apps/notifications-service/test \
  scripts/docker/check-kafka-topics.mjs \
  docker/kafka/topics.txt
git commit -F - <<'EOF'
refactor(contracts,transport): pass Kafka event contracts as values

Each topic is one EventContract { topic, payload } value. KafkaEventPattern,
ParseEventEnvelopePipe, KafkaProducer and FakeKafkaProducer take the contract
instead of a KafkaTopic name, and the KAFKA_TOPICS / EVENT_*_SCHEMAS aggregates
are gone. Envelope schemas are built once per contract. Transport specs use
test-local fixture contracts.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```


### Task contracts-3: Per-domain contracts packages (`domains/<x>/contracts`)

**Files:**
- Move: `libs/contracts/src/proto/identity` -> `domains/identity/contracts/src/proto/identity`
- Move: `libs/contracts/src/generated/identity` -> `domains/identity/contracts/src/generated/identity`
- Move: `libs/contracts/src/grpc/identity.grpc-package.ts` -> `domains/identity/contracts/src/grpc/identity.grpc-package.ts`
- Move: `libs/contracts/src/grpc/identity.grpc-package.spec.ts` -> `domains/identity/contracts/src/grpc/identity.grpc-package.spec.ts`
- Move: `libs/contracts/src/events/identity.events.ts` -> `domains/identity/contracts/src/events/identity.events.ts`
- Move: `libs/contracts/src/events/identity.events.spec.ts` -> `domains/identity/contracts/src/events/identity.events.spec.ts`
- Move: `libs/contracts/src/proto/billing` -> `domains/billing/contracts/src/proto/billing`
- Move: `libs/contracts/src/generated/billing` -> `domains/billing/contracts/src/generated/billing`
- Move: `libs/contracts/src/grpc/billing.grpc-package.ts` -> `domains/billing/contracts/src/grpc/billing.grpc-package.ts`
- Move: `libs/contracts/src/grpc/billing.grpc-package.spec.ts` -> `domains/billing/contracts/src/grpc/billing.grpc-package.spec.ts`
- Move: `libs/contracts/src/events/billing.events.ts` -> `domains/billing/contracts/src/events/billing.events.ts`
- Move: `libs/contracts/src/events/billing.events.spec.ts` -> `domains/billing/contracts/src/events/billing.events.spec.ts`
- Move: `libs/contracts/src/proto/notifications` -> `domains/notifications/contracts/src/proto/notifications`
- Move: `libs/contracts/src/generated/notifications` -> `domains/notifications/contracts/src/generated/notifications`
- Move: `libs/contracts/src/grpc/notifications.grpc-package.ts` -> `domains/notifications/contracts/src/grpc/notifications.grpc-package.ts`
- Move: `libs/contracts/src/grpc/notifications.grpc-package.spec.ts` -> `domains/notifications/contracts/src/grpc/notifications.grpc-package.spec.ts`
- Move: `libs/contracts/src/events/notifications.events.ts` -> `domains/notifications/contracts/src/events/notifications.events.ts`
- Move: `libs/contracts/src/events/notifications.events.spec.ts` -> `domains/notifications/contracts/src/events/notifications.events.spec.ts`
- Move: `libs/contracts/src/generated/google` -> `domains/identity/contracts/src/generated/google`
- Create: `domains/identity/contracts/package.json`
- Create: `domains/identity/contracts/src/index.ts`
- Modify: `package.json:15-16,154`
- Modify: `tsconfig.json:17-18`
- Modify: `vitest.config.ts:12-13,18,20,23-25,24,29,33,41,103,108-111,113-117`
- Modify: `libs/contracts/src/index.ts` (whole file)
- Modify: `libs/contracts/package.json:6,24-26,37-41`
- Modify: `libs/contracts/scripts/proto-esm-fix.mjs:2,16`
- Modify: `Dockerfile:37,68`
- Modify: `.github/workflows/ci.yml:78,80-81`
- Modify: `scripts/docker/check-kafka-topics.mjs:2-4,6,8,10-13,15`
- Create/Modify (exact edits in patch `contracts-3-step02.patch`): `domains/identity/contracts/tsconfig.json`, `domains/identity/contracts/README.md`, `domains/billing/contracts/package.json`, `domains/billing/contracts/tsconfig.json`, `domains/billing/contracts/README.md`, `domains/notifications/contracts/package.json`, `domains/notifications/contracts/tsconfig.json`, `domains/notifications/contracts/README.md`
- Create/Modify (exact edits in patch `contracts-3-step05.patch`): `domains/identity/contracts/src/grpc/identity.grpc-package.ts`, `domains/identity/contracts/src/events/identity.events.ts`, `domains/billing/contracts/src/index.ts`, `domains/billing/contracts/src/grpc/billing.grpc-package.ts`, `domains/billing/contracts/src/events/billing.events.ts`, `domains/notifications/contracts/src/index.ts`, `domains/notifications/contracts/src/grpc/notifications.grpc-package.ts`, `domains/notifications/contracts/src/events/notifications.events.ts`
- Create/Modify (exact edits in patch `contracts-3-step06.patch`): `libs/contracts/README.md`, `libs/contracts/buf.yaml`, `libs/contracts/buf.gen.yaml`
- Create/Modify (exact edits in patch `contracts-3-step09.patch`): `domains/identity/package.json`, `domains/billing/package.json`, `domains/notifications/package.json`, `apps/identity-service/package.json`, `apps/billing-service/package.json`, `apps/notifications-service/package.json`, `apps/monolith/package.json`, `apps/gateway/package.json`
- Create/Modify (exact edits in patch `contracts-3-step12.patch`): `scripts/docker/assemble-image.mjs`
- Create/Modify (exact edits in patch `contracts-3-step13.patch`): `README.md`, `domains/identity/README.md`, `domains/billing/README.md`, `docs/ARCHITECTURE.md`, `docs/API.md`, `docs/PERFORMANCE.md`, `docs/DOCKER.md`, `docs/RELEASING.md`, `docs/DEVELOPMENT.md`
- Create (generated by Step 7): `domains/billing/contracts/src/generated/google/protobuf/timestamp.pb.ts`, `domains/notifications/contracts/src/generated/google/protobuf/{empty,timestamp}.pb.ts`
- Modify (codemod, Step 10): every `apps/**/*.ts` and `domains/**/*.ts` file that imports `@platform/contracts`, outside `domains/*/contracts` (112 files at HEAD 74f70b7 + contracts-1/2)
- Modify: `bun.lock` (by `bun install`)
- Test: `npx vitest run --project identity-contracts --project billing-contracts --project notifications-contracts`
- Test: `contracts`, `transport`, `identity`, `billing`, `notifications`, the five `<app>:e2e` projects
- Test: `bun run typecheck`, `bun run proto:gen`, `bun run proto:lint`, `node scripts/docker/check-kafka-topics.mjs`

**Interfaces:**
- Consumes: Tasks contracts-1 and contracts-2.
- Produces: workspaces `domains/identity/contracts` (`@domain/identity-contracts`), `domains/billing/contracts` (`@domain/billing-contracts`), `domains/notifications/contracts` (`@domain/notifications-contracts`), glob `"domains/*/contracts"`; Vitest projects `identity-contracts`, `billing-contracts`, `notifications-contracts`. Each barrel `src/index.ts` exports the ts-proto types flat and as `identityV1` / `billingV1` / `notificationsV1`, `type Empty` (identity, notifications), the package spec (`IDENTITY_GRPC_PACKAGE`, `BILLING_GRPC_PACKAGE`, `NOTIFICATIONS_GRPC_PACKAGE`: `GrpcPackageSpec`) and the event contract with its payload schema and type (`USER_REGISTERED_EVENT`, `PAYMENT_SUCCEEDED_EVENT`, `NOTIFICATION_CREATED_EVENT`: `EventContract<…>`; `NOTIFICATION_TYPES`, `NotificationType`).
- Produces (`@platform/contracts`, generic only): everything listed under contracts-1/2 for `@platform/contracts`, plus the shared tooling `libs/contracts/buf.yaml` (module `src/proto`, used with `--config` from each package), `libs/contracts/buf.gen.yaml` (`--template`), `node libs/contracts/scripts/proto-esm-fix.mjs <generated dir>` (argument now required).
- Produces (root): scripts `proto:gen` (every contracts package + the transport fixture) and `proto:lint`; `scripts/docker/assemble-image.mjs` reads the root `workspaces` globs; `scripts/docker/check-kafka-topics.mjs` discovers `domains/*/contracts`.

- [ ] **Step 1: Teach the workspace about nested contracts packages**

Bun, Nx, lerna and commitlint read the `workspaces` globs; `bun run --filter "./domains/*"` does NOT match `domains/<x>/contracts` (verified with Bun 1.4.3), hence the explicit filters. Vitest names the nested projects `<x>-contracts` (folder names would collide with `contracts`).

`package.json` (lines 15-16), replace:

```json
    "domains/*",
    "libs/*"
```

with:

```json
    "domains/*",
    "domains/*/contracts",
    "libs/*"
```

`package.json` (line 154), replace:

```json
    "proto:gen": "bun run --filter @platform/contracts --filter @platform/transport proto:gen",
```

with:

```json
    "proto:gen": "bun run --filter './domains/*/contracts' --filter @platform/transport proto:gen",
    "proto:lint": "bun run --filter './domains/*/contracts' proto:lint",
```

`tsconfig.json` (lines 17-18), replace:

```json
    "domains/*/*.ts",
    "libs/*/src",
```

with:

```json
    "domains/*/*.ts",
    "domains/*/contracts/src",
    "domains/*/contracts/test",
    "domains/*/contracts/*.ts",
    "libs/*/src",
```

`vitest.config.ts` (lines 12-13), replace:

```ts
/** Every folder under apps/, domains/ and libs/ that has a package.json is a Vitest project named after it. */
const packagesIn = (dir: WorkspaceDir): string[] =>
```

with:

```ts
interface WorkspacePackage {
  /** Vitest project name: the folder name, `<domain>-contracts` for domains/<domain>/contracts. */
  name: string;
  root: string;
}

/**
 * Every folder under apps/, domains/ and libs/ that has a package.json is a Vitest project named
 * after it. A domain's nested contracts package (domains/<x>/contracts) is the project
 * `<x>-contracts`; the domain's own project only includes its src/ and test/ folders.
 */
const packagesIn = (dir: WorkspaceDir): WorkspacePackage[] =>
```

`vitest.config.ts` (line 18), replace:

```ts
    .map((entry) => entry.name);
```

with:

```ts
    .flatMap((entry) => {
      const root = join(ROOT, dir, entry.name);
      const contracts = join(root, 'contracts');
      return existsSync(join(contracts, 'package.json'))
        ? [
            { name: entry.name, root },
            { name: `${entry.name}-contracts`, root: contracts },
          ]
        : [{ name: entry.name, root }];
    });
```

`vitest.config.ts` (line 20), replace:

```ts
const unitProject = (dir: WorkspaceDir, name: string): TestProjectInlineConfiguration => ({
```

with:

```ts
const unitProject = ({ name, root }: WorkspacePackage): TestProjectInlineConfiguration => ({
```

`vitest.config.ts` (lines 23-25), replace:

```ts
    name,
    root: join(ROOT, dir, name),
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
```

with:

```ts
    name,
    root,
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
```

`vitest.config.ts` (line 29), replace:

```ts
const e2eProject = (name: string): TestProjectInlineConfiguration => ({
```

with:

```ts
const e2eProject = ({ name, root }: WorkspacePackage): TestProjectInlineConfiguration => ({
```

`vitest.config.ts` (line 33), replace:

```ts
    root: join(ROOT, 'apps', name),
```

with:

```ts
    root,
```

`vitest.config.ts` (line 41), replace:

```ts
const intProject = (dir: WorkspaceDir, name: string): TestProjectInlineConfiguration => ({
```

with:

```ts
const intProject = ({ name, root }: WorkspacePackage): TestProjectInlineConfiguration => ({
```

`vitest.config.ts` (line 24), replace:

```ts
    root: join(ROOT, dir, name),
```

with:

```ts
    root,
```

`vitest.config.ts` (line 103), replace:

```ts
      include: ['apps/*/src/**/*.ts', 'domains/*/src/**/*.ts', 'libs/*/src/**/*.ts'],
```

with:

```ts
      include: [
        'apps/*/src/**/*.ts',
        'domains/*/src/**/*.ts',
        'domains/*/contracts/src/**/*.ts',
        'libs/*/src/**/*.ts',
      ],
```

`vitest.config.ts` (lines 108-111), replace:

```ts
      ...domains.map((name) => unitProject('domains', name)),
      ...libs.map((name) => unitProject('libs', name)),
      ...apps.map((name) => unitProject('apps', name)),
      ...apps.map((name) => e2eProject(name)),
```

with:

```ts
      ...domains.map(unitProject),
      ...libs.map(unitProject),
      ...apps.map(unitProject),
      ...apps.map(e2eProject),
```

`vitest.config.ts` (lines 113-117), replace:

```ts
        ? [
            ...domains.map((name) => intProject('domains', name)),
            ...libs.map((name) => intProject('libs', name)),
            ...apps.map((name) => intProject('apps', name)),
          ]
```

with:

```ts
        ? [...domains.map(intProject), ...libs.map(intProject), ...apps.map(intProject)]
```


- [ ] **Step 2: Create the three package shells**

Same scripts as every package, one level deeper (`../../../`). `proto:gen` and `proto:lint` run buf from the package folder with the shared policy and template of `@platform/contracts` (buf rejects module paths outside the folder it runs in, so one workspace cannot list the domains). The READMEs document the package, its usage and codegen, and `buf breaking` against the package's own proto root.

Create `domains/identity/contracts/package.json`:

```json
{
  "name": "@domain/identity-contracts",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "description": "Published language of the identity context: identity.v1 protobuf + ts-proto (NestJS) types, its gRPC package spec, and the user-registered integration event.",
  "exports": {
    ".": {
      "@repo/source": "./src/index.ts",
      "types": "./src/index.ts",
      "default": "./dist/index.js"
    },
    "./package.json": "./package.json"
  },
  "scripts": {
    "build": "swc src -d dist --config-file ../../../.swcrc --cli-config-file ../../../swc.cli.json",
    "typecheck": "tsc -p tsconfig.json",
    "test": "vitest run --config ../../../vitest.config.ts --project identity-contracts",
    "clean": "rimraf dist coverage",
    "proto:gen": "buf generate --template ../../../libs/contracts/buf.gen.yaml --config ../../../libs/contracts/buf.yaml && node ../../../libs/contracts/scripts/proto-esm-fix.mjs src/generated",
    "proto:lint": "buf lint --config ../../../libs/contracts/buf.yaml"
  },
  "dependencies": {
    "@platform/contracts": "workspace:*",
    "@grpc/grpc-js": "catalog:",
    "@nestjs/common": "catalog:",
    "@nestjs/core": "catalog:",
    "@nestjs/microservices": "catalog:",
    "protobufjs": "catalog:",
    "reflect-metadata": "catalog:",
    "rxjs": "catalog:",
    "zod": "catalog:"
  },
  "devDependencies": {
    "@bufbuild/buf": "catalog:",
    "ts-proto": "catalog:"
  }
}
```

Apply the validated patch with these exact edits (the old -> new snippets are also in `docs/superpowers/plans/2026-10-12-b1-ownership-moves/artifacts/contracts/plan-contracts-lane.md`, contracts-3 Step 2, for hand application):

```bash
git apply --index docs/superpowers/plans/2026-10-12-b1-ownership-moves/artifacts/contracts/patches/contracts-3-step02.patch
```

Expected: applies cleanly and stages exactly: `domains/billing/contracts/README.md`, `domains/billing/contracts/package.json`, `domains/billing/contracts/tsconfig.json`, `domains/identity/contracts/README.md`, `domains/identity/contracts/tsconfig.json`, `domains/notifications/contracts/README.md`, `domains/notifications/contracts/package.json`, `domains/notifications/contracts/tsconfig.json`.

- [ ] **Step 3: Move each domain's proto, generated code, package spec and event contract (with their specs)**

Pure moves. The identity package also takes the committed `google/protobuf` output; the other two get theirs from `proto:gen` in Step 7.

```bash
mkdir -p domains/identity/contracts/src/proto
git mv libs/contracts/src/proto/identity domains/identity/contracts/src/proto/identity
mkdir -p domains/identity/contracts/src/generated
git mv libs/contracts/src/generated/identity domains/identity/contracts/src/generated/identity
mkdir -p domains/identity/contracts/src/grpc
git mv libs/contracts/src/grpc/identity.grpc-package.ts domains/identity/contracts/src/grpc/identity.grpc-package.ts
git mv libs/contracts/src/grpc/identity.grpc-package.spec.ts domains/identity/contracts/src/grpc/identity.grpc-package.spec.ts
mkdir -p domains/identity/contracts/src/events
git mv libs/contracts/src/events/identity.events.ts domains/identity/contracts/src/events/identity.events.ts
git mv libs/contracts/src/events/identity.events.spec.ts domains/identity/contracts/src/events/identity.events.spec.ts
mkdir -p domains/billing/contracts/src/proto
git mv libs/contracts/src/proto/billing domains/billing/contracts/src/proto/billing
mkdir -p domains/billing/contracts/src/generated
git mv libs/contracts/src/generated/billing domains/billing/contracts/src/generated/billing
mkdir -p domains/billing/contracts/src/grpc
git mv libs/contracts/src/grpc/billing.grpc-package.ts domains/billing/contracts/src/grpc/billing.grpc-package.ts
git mv libs/contracts/src/grpc/billing.grpc-package.spec.ts domains/billing/contracts/src/grpc/billing.grpc-package.spec.ts
mkdir -p domains/billing/contracts/src/events
git mv libs/contracts/src/events/billing.events.ts domains/billing/contracts/src/events/billing.events.ts
git mv libs/contracts/src/events/billing.events.spec.ts domains/billing/contracts/src/events/billing.events.spec.ts
mkdir -p domains/notifications/contracts/src/proto
git mv libs/contracts/src/proto/notifications domains/notifications/contracts/src/proto/notifications
mkdir -p domains/notifications/contracts/src/generated
git mv libs/contracts/src/generated/notifications domains/notifications/contracts/src/generated/notifications
mkdir -p domains/notifications/contracts/src/grpc
git mv libs/contracts/src/grpc/notifications.grpc-package.ts domains/notifications/contracts/src/grpc/notifications.grpc-package.ts
git mv libs/contracts/src/grpc/notifications.grpc-package.spec.ts domains/notifications/contracts/src/grpc/notifications.grpc-package.spec.ts
mkdir -p domains/notifications/contracts/src/events
git mv libs/contracts/src/events/notifications.events.ts domains/notifications/contracts/src/events/notifications.events.ts
git mv libs/contracts/src/events/notifications.events.spec.ts domains/notifications/contracts/src/events/notifications.events.spec.ts
git mv libs/contracts/src/generated/google domains/identity/contracts/src/generated/google
```


- [ ] **Step 4: Remove the emptied folders**

```bash
rmdir libs/contracts/src/generated libs/contracts/src/proto
```


- [ ] **Step 5: Point the moved files at @platform/contracts and add the barrels**

Each barrel exports its generated types flat and as `<x>V1`, `type Empty` where the proto imports it (identity, notifications), the package spec and the event contract.

Create `domains/identity/contracts/src/index.ts`:

```ts
/**
 * @domain/identity-contracts — the published language of the identity context: the identity.v1
 * gRPC contract (ts-proto NestJS output + `IDENTITY_GRPC_PACKAGE`) and the user-registered event
 * (`USER_REGISTERED_EVENT`). Other domains and the apps depend on this package to talk to
 * identity; only the composition roots import @domain/identity itself.
 *
 * - Generated types are re-exported flat (`User`, `AuthTokens`, …) and as the version-qualified
 *   namespace `identityV1`, the escape hatch for a later `v2`.
 * - Loading this barrel evaluates the generated module, which registers the protobuf
 *   Timestamp <-> Date wrapper (see grpc/identity.grpc-package.ts).
 */
export * from './events/identity.events.js';
export type { Empty } from './generated/google/protobuf/empty.pb.js';
export * from './generated/identity/v1/identity.pb.js';
export * as identityV1 from './generated/identity/v1/identity.pb.js';
export * from './grpc/identity.grpc-package.js';
```

Apply the validated patch with these exact edits (the old -> new snippets are also in `docs/superpowers/plans/2026-10-12-b1-ownership-moves/artifacts/contracts/plan-contracts-lane.md`, contracts-3 Step 5, for hand application):

```bash
git apply --index docs/superpowers/plans/2026-10-12-b1-ownership-moves/artifacts/contracts/patches/contracts-3-step05.patch
```

Expected: applies cleanly and stages exactly: `domains/billing/contracts/src/events/billing.events.ts`, `domains/billing/contracts/src/grpc/billing.grpc-package.ts`, `domains/billing/contracts/src/index.ts`, `domains/identity/contracts/src/events/identity.events.ts`, `domains/identity/contracts/src/grpc/identity.grpc-package.ts`, `domains/notifications/contracts/src/events/notifications.events.ts`, `domains/notifications/contracts/src/grpc/notifications.grpc-package.ts`, `domains/notifications/contracts/src/index.ts`.

- [ ] **Step 6: Slim @platform/contracts to the generic code and the shared codegen tooling**

Its barrel must stop re-exporting the moved files before anything imports it again. `proto-esm-fix.mjs` now requires its output folder (its old default, `libs/contracts/src/generated`, no longer exists). The README is rewritten for the generic package. `buf.yaml` and `buf.gen.yaml` only get comments that explain the shared, run-from-the-package usage.

Replace the whole content of `libs/contracts/src/index.ts`:

```ts
/**
 * @platform/contracts — the generic half of the wire contracts. Each domain publishes its own
 * contracts package (`domains/<x>/contracts`, `@domain/<x>-contracts`) built on these types, and
 * `@platform/transport` only ever takes their values:
 * - gRPC: `GrpcPackageSpec` (one per protobuf package), `resolveGrpcPackages` and the
 *   proto-loader options that mirror the shared ts-proto template (`buf.gen.yaml`).
 * - Kafka: `EventContract` (one per topic), the envelope schema with its parse and build helpers,
 *   the topic naming helpers and the record header names.
 * - `@platform/contracts/testing`: wire-format helpers for the contracts packages' specs.
 */
export * from './events/envelope.js';
export * from './events/event-contract.js';
export * from './events/kafka-headers.constants.js';
export * from './events/topics.js';
export * from './grpc/grpc-package-spec.js';
```

`libs/contracts/package.json` (line 6), replace:

```json
  "description": "Wire contracts: gRPC protobuf definitions + ts-proto (NestJS) types, and zod-validated Kafka integration-event envelopes.",
```

with:

```json
  "description": "Generic wire-contract plumbing for the domain contracts packages: GrpcPackageSpec and proto-loader options, EventContract and validated Kafka envelopes, topic helpers, and the shared buf policy and ts-proto template.",
```

`libs/contracts/package.json` (lines 24-26), replace:

```json
    "clean": "rimraf dist coverage",
    "proto:gen": "buf generate && node scripts/proto-esm-fix.mjs",
    "proto:lint": "buf lint"
```

with:

```json
    "clean": "rimraf dist coverage"
```

`libs/contracts/package.json` (lines 37-41), replace:

```json
  },
  "devDependencies": {
    "@bufbuild/buf": "catalog:",
    "ts-proto": "catalog:"
  }
```

with:

```json
  }
```

`libs/contracts/scripts/proto-esm-fix.mjs` (line 2), replace:

```js
// type-check under the repo's strict tsconfig. Idempotent; run by `bun run proto:gen`.
```

with:

```js
// type-check under the repo's strict tsconfig. Idempotent; every contracts package's `proto:gen`
// runs it on its own output: `node ../../../libs/contracts/scripts/proto-esm-fix.mjs src/generated`.
```

`libs/contracts/scripts/proto-esm-fix.mjs` (line 16), replace:

```js
const root = resolve(process.argv[2] ?? join(import.meta.dirname, '..', 'src', 'generated'));
```

with:

```js
const [target] = process.argv.slice(2);
if (target === undefined) {
  console.error('usage: node proto-esm-fix.mjs <generated dir>');
  process.exit(2);
}
const root = resolve(target);
```

Apply the validated patch with these exact edits (the old -> new snippets are also in `docs/superpowers/plans/2026-10-12-b1-ownership-moves/artifacts/contracts/plan-contracts-lane.md`, contracts-3 Step 6, for hand application):

```bash
git apply --index docs/superpowers/plans/2026-10-12-b1-ownership-moves/artifacts/contracts/patches/contracts-3-step06.patch
```

Expected: applies cleanly and stages exactly: `libs/contracts/README.md`, `libs/contracts/buf.gen.yaml`, `libs/contracts/buf.yaml`.

- [ ] **Step 7: Install, generate and lint**

```bash
bun install
bun run proto:gen
bun run proto:lint
git diff --exit-code -- domains/*/contracts/src/generated
git status --porcelain -uall -- domains/*/contracts/src/generated | grep '^??'
```

Expected: `bun install` adds the three `@domain/*-contracts` workspaces to `bun.lock` (no version changes); `proto:gen` prints `proto-esm-fix: patched 1 file(s) in src/generated` four times (three packages + transport fixture); `proto:lint` exits 0; `git diff` exits 0 (no moved file changed); `grep` prints exactly three new files: `domains/billing/contracts/src/generated/google/protobuf/timestamp.pb.ts`, `domains/notifications/contracts/src/generated/google/protobuf/empty.pb.ts`, `domains/notifications/contracts/src/generated/google/protobuf/timestamp.pb.ts` (byte-identical to the moved identity copies).


- [ ] **Step 8: Run the moved specs in their new projects and the slimmed platform package**

```bash
npx vitest list --project identity-contracts --project billing-contracts --project notifications-contracts | cut -d">" -f1 | sort | uniq -c
npx vitest run --project identity-contracts --project billing-contracts \
  --project notifications-contracts --project contracts
```

Expected: the list shows `src/events/<x>.events.spec.ts` and `src/grpc/<x>.grpc-package.spec.ts` under each `[<x>-contracts]` project; the run passes (9 files: 6 moved + `event-contract`, `topics`, `grpc-package-spec`). The domains and apps do not compile until Step 10 rewrites their imports.


- [ ] **Step 9: Declare the contracts packages where they are imported**

Apps keep their existing `@platform/contracts` entry. `domains/billing` needs `@domain/identity-contracts` only while `billing.resolver.ts` still imports `User`; lane billing removes both with `Payment.user`. Added: identity, billing and notifications get their own contracts package; notifications also gets `@domain/identity-contracts` and `@domain/billing-contracts`; billing gets `@domain/identity-contracts`; each service app gets its own contracts package; devDependencies: notifications-service and monolith `@domain/identity-contracts`, gateway `@domain/identity-contracts` and `@domain/notifications-contracts`.

Apply the validated patch with these exact edits (the old -> new snippets are also in `docs/superpowers/plans/2026-10-12-b1-ownership-moves/artifacts/contracts/plan-contracts-lane.md`, contracts-3 Step 9, for hand application):

```bash
git apply --index docs/superpowers/plans/2026-10-12-b1-ownership-moves/artifacts/contracts/patches/contracts-3-step09.patch
```

Expected: applies cleanly and stages exactly: `apps/billing-service/package.json`, `apps/gateway/package.json`, `apps/identity-service/package.json`, `apps/monolith/package.json`, `apps/notifications-service/package.json`, `domains/billing/package.json`, `domains/identity/package.json`, `domains/notifications/package.json`.

- [ ] **Step 10: Rewrite every importer with a codemod**

The codemod is saved at `docs/superpowers/plans/2026-10-12-b1-ownership-moves/artifacts/contracts/codemods/b1-contracts-imports-codemod.mjs` (not committed). It splits each `@platform/contracts` import by imported name into `@domain/identity-contracts`, `@domain/billing-contracts`, `@domain/notifications-contracts` and `@platform/contracts` (an `OWNERS` table of every exported name; an unknown name aborts). Copy it:

```bash
cp docs/superpowers/plans/2026-10-12-b1-ownership-moves/artifacts/contracts/codemods/b1-contracts-imports-codemod.mjs "$TMPDIR/"
```

Run it on every tracked importer in `apps/` and `domains/` (outside the contracts packages), then let Biome sort the split imports:

```bash
git grep -l "@platform/contracts'" -- 'apps/**/*.ts' 'domains/**/*.ts' ':!domains/*/contracts/**' > "$TMPDIR/b1-contracts-importers.txt"
bun install
node "$TMPDIR/b1-contracts-imports-codemod.mjs" $(cat "$TMPDIR/b1-contracts-importers.txt")
npx biome check --write $(cat "$TMPDIR/b1-contracts-importers.txt")
```

Expected: 112 files listed at HEAD 74f70b7 plus Tasks contracts-1/2 (more if another lane added importers first), `rewrote <file>` for all but the three `apps/*-service/test/support/service-test-app.ts` (they only import the generic `GrpcPackageSpec`), and Biome exits 0. An unknown name aborts with `no owner for "<name>"`: add it to `OWNERS`.


- [ ] **Step 11: Typecheck and run every affected project**

```bash
bun run typecheck
npx vitest run --project contracts --project transport --project identity --project billing \
  --project notifications --project identity-contracts --project billing-contracts \
  --project notifications-contracts --project 'identity-service:e2e' \
  --project 'billing-service:e2e' --project 'notifications-service:e2e' \
  --project 'gateway:e2e' --project 'monolith:e2e'
```

Expected: PASS.


- [ ] **Step 12: Images, CI and the topic check**

`assemble-image.mjs` discovers workspace packages from the root `workspaces` globs (copied by the manifests stage) and, when it prunes a domain an image does not need, keeps a nested contracts package the image does need (notifications-service ships `domains/identity/contracts` without `domains/identity`; verified on a simulated prod-deps tree). `check-kafka-topics.mjs` imports every `domains/*/contracts` package.

`Dockerfile` (line 37), replace:

```dockerfile
COPY --parents package.json bun.lock bunfig.toml apps/*/package.json domains/*/package.json libs/*/package.json ./
```

with:

```dockerfile
COPY --parents package.json bun.lock bunfig.toml apps/*/package.json domains/*/package.json domains/*/contracts/package.json libs/*/package.json ./
```

`Dockerfile` (line 68), replace:

```dockerfile
RUN bun run --filter "./libs/*" --filter "./domains/*" --filter "./apps/${APP}" build
```

with:

```dockerfile
RUN bun run --filter "./libs/*" --filter "./domains/*" --filter "./domains/*/contracts" --filter "./apps/${APP}" build
```

`.github/workflows/ci.yml` (line 78), replace:

```yaml
          bun run --filter @platform/contracts proto:lint
```

with:

```yaml
          bun run proto:lint
```

`.github/workflows/ci.yml` (lines 80-81), replace:

```yaml
          git diff --exit-code -- libs/contracts/src/generated libs/transport/test/fixtures/src/generated libs/database/src/migrations
          test -z "$(git status --porcelain -- libs/contracts/src/generated libs/transport/test/fixtures/src/generated libs/database/src/migrations)"
```

with:

```yaml
          git diff --exit-code -- domains/*/contracts/src/generated libs/transport/test/fixtures/src/generated libs/database/src/migrations
          test -z "$(git status --porcelain -- domains/*/contracts/src/generated libs/transport/test/fixtures/src/generated libs/database/src/migrations)"
```

`scripts/docker/check-kafka-topics.mjs` (lines 2-4), replace:

```js
// topic of every exported event contract (`<EVENT>_EVENT`) plus its `.dlq` twin (broker
// auto-creation is off, so a missing topic makes consumers fail at boot). Needs the built
// contracts (`bun run build`):
```

with:

```js
// topic of every event contract (`<EVENT>_EVENT`) exported by a domains/<x>/contracts package, plus
// its `.dlq` twin (broker auto-creation is off, so a missing topic makes consumers fail at boot).
// Needs the built contracts packages (`bun run build`):
```

`scripts/docker/check-kafka-topics.mjs` (line 6), replace:

```js
import { readFileSync } from 'node:fs';
```

with:

```js
import { existsSync, readdirSync, readFileSync } from 'node:fs';
```

`scripts/docker/check-kafka-topics.mjs` (line 8), replace:

```js
import * as contracts from '@platform/contracts';
```

with:

```js
import { deadLetterTopic, isEventContract } from '@platform/contracts';
```

`scripts/docker/check-kafka-topics.mjs` (lines 10-13), replace:

```js
const { deadLetterTopic, isEventContract } = contracts;
const topics = Object.values(contracts)
  .filter(isEventContract)
  .map((contract) => contract.topic);
```

with:

```js
const root = join(import.meta.dirname, '..', '..');
const topics = [];
for (const domain of readdirSync(join(root, 'domains'))) {
  const manifest = join(root, 'domains', domain, 'contracts', 'package.json');
  if (!existsSync(manifest)) continue;
  const { name } = JSON.parse(readFileSync(manifest, 'utf8'));
  for (const value of Object.values(await import(name))) {
    if (isEventContract(value)) topics.push(value.topic);
  }
}
```

`scripts/docker/check-kafka-topics.mjs` (line 15), replace:

```js
const file = join(import.meta.dirname, '..', '..', 'docker', 'kafka', 'topics.txt');
```

with:

```js
const file = join(root, 'docker', 'kafka', 'topics.txt');
```

Apply the validated patch with these exact edits (the old -> new snippets are also in `docs/superpowers/plans/2026-10-12-b1-ownership-moves/artifacts/contracts/plan-contracts-lane.md`, contracts-3 Step 12, for hand application):

```bash
git apply --index docs/superpowers/plans/2026-10-12-b1-ownership-moves/artifacts/contracts/patches/contracts-3-step12.patch
```

Expected: applies cleanly and stages exactly: `scripts/docker/assemble-image.mjs`.

- [ ] **Step 13: Docs**

Table rows keep their cell widths, so Prettier does not realign tables other lanes may also edit.

Apply the validated patch with these exact edits (the old -> new snippets are also in `docs/superpowers/plans/2026-10-12-b1-ownership-moves/artifacts/contracts/plan-contracts-lane.md`, contracts-3 Step 13, for hand application):

```bash
git apply --index docs/superpowers/plans/2026-10-12-b1-ownership-moves/artifacts/contracts/patches/contracts-3-step13.patch
```

Expected: applies cleanly and stages exactly: `README.md`, `docs/API.md`, `docs/ARCHITECTURE.md`, `docs/DEVELOPMENT.md`, `docs/DOCKER.md`, `docs/PERFORMANCE.md`, `docs/RELEASING.md`, `domains/billing/README.md`, `domains/identity/README.md`.

- [ ] **Step 14: Run the gate**

```bash
bun run check
bun run test
bun run build
node scripts/docker/check-kafka-topics.mjs
git add domains/*/contracts libs/contracts
bun run proto:gen && bun run proto:lint
git diff --exit-code -- domains/*/contracts/src/generated libs/transport/test/fixtures/src/generated
git status --porcelain -uall -- domains/*/contracts/src/generated | grep '^??'
```

Expected: everything passes (`Layer boundaries OK (24 packages: apps -> domains -> libs).`: the old script does not see nested packages until Task contracts-4); the topic check prints `provisions all 6 contract topics`; `git diff` exits 0 and `grep` prints nothing. In the lab replica the full suite was 224 files / 1738 tests. The CI image job is the check for the Dockerfile and assemble-image changes.


- [ ] **Step 15: Commit**

```bash
git add domains/identity \
  domains/billing \
  domains/notifications \
  libs/contracts \
  apps \
  package.json \
  bun.lock \
  tsconfig.json \
  vitest.config.ts \
  Dockerfile \
  scripts/docker/assemble-image.mjs \
  scripts/docker/check-kafka-topics.mjs \
  .github/workflows/ci.yml \
  README.md \
  docs
git commit -F - <<'EOF'
refactor(contracts): move each domain's contracts into its own package

domains/<x>/contracts (@domain/<x>-contracts) now owns the context's proto, the
ts-proto output, its GrpcPackageSpec and its event contracts; @platform/contracts
keeps the generic code, the buf policy and the ts-proto template. Consumers
import only the contracts they use, so notifications-service no longer loads
identity or billing to read their events. Nested workspaces are wired into
Bun, Vitest, tsc, the Dockerfile, assemble-image and the CI drift check.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```


### Task contracts-4: Boundary rules for domains and contracts packages

**Files:**
- Modify: `vitest.config.ts:74-75,135-136`
- Modify: `tsconfig.json:24-25`
- Modify: `scripts/check-boundaries.mjs` (whole file)
- Create/Modify (exact edits in patch `contracts-4-step01.patch`): `scripts/check-boundaries.spec.ts`
- Test: `npx vitest run --project scripts`
- Test: `node scripts/check-boundaries.mjs`
- Test: `bun run check`

**Interfaces:**
- Consumes: lane billing's `PaymentUserFieldResolver` task (`domains/billing` no longer declares, imports or mocks `@domain/identity`); Task contracts-3 (nested packages exist).
- Produces: `node scripts/check-boundaries.mjs [--root <dir>]` with the rules above; Vitest project `scripts` (`scripts/**/*.spec.ts`); root tsconfig include `scripts/**/*.ts`.

- [ ] **Step 1: Write the failing spec and give scripts/ a Vitest project**

The spec runs the script as a child process against throwaway repo trees (`--root <dir>`), so it tests the real CLI. `scripts/**/*.ts` joins the root tsconfig so type-aware ESLint accepts the spec. Cases: the layered layout passes and counts nested packages (7); a domain depending on / mocking another domain fails; a `@domain/<y>/testing` subpath fails; a contracts package importing another platform package, its own domain, another contracts package or an app fails; relative imports leaving the package fail (both directions); a misnamed contracts package fails; a platform package importing a contracts package fails.

`vitest.config.ts` (lines 74-75), replace:

```ts

export default defineConfig({
```

with:

```ts

/** Repo tooling under scripts/ (e.g. the layer boundary check), specs only. */
const scriptsProject: TestProjectInlineConfiguration = {
  extends: true,
  test: { name: 'scripts', root: join(ROOT, 'scripts'), include: ['**/*.spec.ts'] },
};

export default defineConfig({
```

`vitest.config.ts` (lines 135-136), replace:

```ts
      ...apps.map(e2eProject),
      ...(INTEGRATION
```

with:

```ts
      ...apps.map(e2eProject),
      scriptsProject,
      ...(INTEGRATION
```

`tsconfig.json` (lines 24-25), replace:

```json
    "*.ts",
    "typings/**/*.d.ts"
```

with:

```json
    "*.ts",
    "scripts/**/*.ts",
    "typings/**/*.d.ts"
```

Apply the validated patch with these exact edits (the old -> new snippets are also in `docs/superpowers/plans/2026-10-12-b1-ownership-moves/artifacts/contracts/plan-contracts-lane.md`, contracts-4 Step 1, for hand application):

```bash
git apply --index docs/superpowers/plans/2026-10-12-b1-ownership-moves/artifacts/contracts/patches/contracts-4-step01.patch
```

Expected: applies cleanly and stages exactly: `scripts/check-boundaries.spec.ts`.

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run --project scripts
```

Expected: FAIL, 10 tests. The old script ignores `--root` and checks the real repo: `AssertionError: expected 'Layer boundaries OK (24 packages: app…' to contain 'Layer boundaries OK (7 packages'`.


- [ ] **Step 3: Implement the domain and contracts rules**

New: nested `domains/<x>/contracts` packages are discovered and named `@domain/<x>-contracts`; a domain may import another domain only through `@domain/<y>-contracts` (dependency fields and every specifier, tests included); a contracts package may import only `@platform/contracts` (and its subpaths) and third-party packages; a relative import must stay inside its package (also not into a nested one); a parent package's walk skips its nested package.

Replace the whole content of `scripts/check-boundaries.mjs`:

```js
// Fails when a workspace package crosses the layer boundaries of the repo layout:
//   apps/<x>               @app/<x>                deployables: may depend on anything below them
//   domains/<x>            @domain/<x>             a bounded context: @platform/* and its own
//                                                  contracts; another domain ONLY through that
//                                                  domain's @domain/<y>-contracts package
//   domains/<x>/contracts  @domain/<x>-contracts   the context's published language:
//                                                  @platform/contracts and third-party packages only
//   libs/<x>               @platform/<x>           platform + shared kernel: @platform/* only
// Checks every package.json dependency field AND every module specifier in the sources (tests
// included, because Biome's noUndeclaredDependencies is off for specs), so a package can neither
// declare nor quietly import what its layer forbids. A relative specifier must stay inside its
// own package: reaching into a sibling or a nested package by path is an import too.
//   node scripts/check-boundaries.mjs [--root <repo root>]
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({ options: { root: { type: 'string' } } });
const root = resolve(args.root ?? join(import.meta.dirname, '..'));

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];
const SOURCE_FILE = /\.(?:[cm]?[jt]s|tsx)$/;
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'coverage', 'generated']);
// import/export … from 'x', import('x'), require('x'), vi.mock('x'), declare module 'x', import 'x'
const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bvi\.mock\s*\(\s*|\bdeclare\s+module\s+|\bimport\s+)['"]([^'"]+)['"]/g;
const CONTRACTS_PACKAGE = /^@domain\/[^/]+-contracts(?:\/|$)/;
const PLATFORM_CONTRACTS = /^@platform\/contracts(?:\/|$)/;
const WORKSPACE_SCOPE = /^@(?:app|domain|platform)\//;

/** Returns why `specifier` is forbidden in a package of `kind` (for domains: of `domain`), or null. */
function violation(kind, domain, specifier) {
  switch (kind) {
    case 'app':
      return null;
    case 'domain':
      if (specifier.startsWith('@app/')) return 'a domain must not import an app';
      if (
        specifier.startsWith('@domain/') &&
        !CONTRACTS_PACKAGE.test(specifier) &&
        specifier !== `@domain/${domain}` &&
        !specifier.startsWith(`@domain/${domain}/`)
      ) {
        return 'a domain may import another domain only through its @domain/<x>-contracts package';
      }
      return null;
    case 'contracts':
      return WORKSPACE_SCOPE.test(specifier) && !PLATFORM_CONTRACTS.test(specifier)
        ? 'a contracts package may import only @platform/contracts and third-party packages'
        : null;
    case 'lib':
      return specifier.startsWith('@app/') || specifier.startsWith('@domain/')
        ? 'a platform package must not import an app or a domain'
        : null;
    default:
      throw new Error(`unknown package kind ${kind}`);
  }
}

/** Every workspace package: { dir (absolute), where (relative), kind, name, domain? }. */
const packages = [];
const subdirs = (dir) =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    : [];
for (const [folder, kind, scope] of [
  ['apps', 'app', '@app/'],
  ['domains', 'domain', '@domain/'],
  ['libs', 'lib', '@platform/'],
]) {
  for (const entry of subdirs(join(root, folder))) {
    const dir = join(root, folder, entry.name);
    if (!existsSync(join(dir, 'package.json'))) continue;
    packages.push({ dir, kind, name: `${scope}${entry.name}`, domain: entry.name });
    if (kind === 'domain' && existsSync(join(dir, 'contracts', 'package.json'))) {
      packages.push({
        dir: join(dir, 'contracts'),
        kind: 'contracts',
        name: `@domain/${entry.name}-contracts`,
        domain: entry.name,
      });
    }
  }
}

const packageDirs = new Set(packages.map((pkg) => pkg.dir));
/** The innermost package that contains `path`, or undefined. */
const ownerOf = (path) =>
  packages
    .filter((pkg) => path === pkg.dir || path.startsWith(`${pkg.dir}${sep}`))
    .sort((a, b) => b.dir.length - a.dir.length)[0];

/** Source files of the package at `dir`, without nested packages (they are checked on their own). */
function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!packageDirs.has(path)) yield* sourceFiles(path);
    } else if (SOURCE_FILE.test(entry.name)) {
      yield path;
    }
  }
}

const problems = [];
for (const pkg of packages) {
  const where = relative(root, pkg.dir);
  const manifest = JSON.parse(readFileSync(join(pkg.dir, 'package.json'), 'utf8'));
  if (manifest.name !== pkg.name) {
    problems.push(`${where}/package.json: name must be "${pkg.name}" (is "${manifest.name}")`);
  }
  for (const field of DEPENDENCY_FIELDS) {
    for (const dep of Object.keys(manifest[field] ?? {})) {
      const reason = violation(pkg.kind, pkg.domain, dep);
      if (reason)
        problems.push(`${where}/package.json: ${field} must not include "${dep}" (${reason})`);
    }
  }
  for (const file of sourceFiles(pkg.dir)) {
    const source = readFileSync(file, 'utf8');
    for (const [, specifier] of source.matchAll(SPECIFIER)) {
      if (specifier.startsWith('.')) {
        if (ownerOf(resolve(dirname(file), specifier)) !== pkg) {
          problems.push(
            `${relative(root, file)}: must not reach outside its package through "${specifier}"`,
          );
        }
        continue;
      }
      const reason = violation(pkg.kind, pkg.domain, specifier);
      if (reason)
        problems.push(`${relative(root, file)}: must not import "${specifier}" (${reason})`);
    }
  }
}

if (packages.length === 0) {
  console.error('no workspace packages found: did the apps/ domains/ libs/ layout change?');
  process.exit(1);
}
if (problems.length > 0) {
  console.error(`Layer boundary violations (${problems.length}):\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(
  `Layer boundaries OK (${packages.length} packages: apps -> domains -> contracts -> libs).`,
);
```


- [ ] **Step 4: Run the spec**

```bash
npx vitest run --project scripts
```

Expected: PASS, 10 tests.


- [ ] **Step 5: Run the check on the repo**

```bash
node scripts/check-boundaries.mjs
```

Expected: `Layer boundaries OK (27 packages: apps -> domains -> contracts -> libs).` If it lists `domains/billing/package.json: dependencies must not include "@domain/identity"` and the four billing files that import or mock `@domain/identity`, lane billing's `PaymentUserFieldResolver` task has not run yet: stop and run it first.


- [ ] **Step 6: Run the gate**

```bash
bun run check
bun run test
```

Expected: PASS.


- [ ] **Step 7: Commit**

```bash
git add scripts/check-boundaries.mjs \
  scripts/check-boundaries.spec.ts \
  vitest.config.ts \
  tsconfig.json
git commit -F - <<'EOF'
feat(tooling): enforce the domain and contracts import rules

check-boundaries now sees the nested contracts packages and enforces that a
domain reaches another domain only through its @domain/<x>-contracts package,
that a contracts package imports only @platform/contracts and third-party
code, and that relative imports stay inside their package. The script takes
--root and has a spec over throwaway repo trees.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

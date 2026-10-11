# Program design: domain layout, multi-tenancy with RLS, rate limiting, hardening

- **Status:** approved 2026-10-12, with option (b) for system access (section 9).
- **Branch:** `feat/domains-tenancy`
- **Date:** 2026-10-12

This document fixes the decisions that cut across the remaining sub-projects, so each one can be planned and built
without reopening them. The bounded sub-projects (H, D, F, E) get short designs in chat. B, C and G get an
implementation plan each, written from this document just before they start.

## 1. Decisions already made

| Topic       | Decision                                                                                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Layout      | `apps/` are the deployables (`@app/*`). `domains/` hold the business code (`@domain/*`). `libs/` hold platform code and the shared kernel (`@platform/*`). Done in A1.                      |
| Ownership   | Each domain owns its tables, migrations, config, templates and contracts. `PasswordHasher` moves to identity; the Stripe adapter moves to billing. Anything domain-specific leaves `libs/`. |
| Tenancy     | Users are global identities (email unique). They join tenants through **memberships**, with a role per tenant.                                                                              |
| Signup      | Registration creates the user and a **personal workspace** they own. Every token always has an active tenant.                                                                               |
| Staff       | Platform staff **switch into** a tenant, audited and with a short-lived token. No request ever spans two tenants.                                                                           |
| RLS         | Postgres enforces **tenant isolation and per-user ownership**, even when a query forgets its filter.                                                                                        |
| Rate limits | Separate **per-user and per-tenant budgets**. Login is limited by account and IP. GraphQL is limited per operation. Standard headers. Limits come from config.                              |
| Extra scope | Production hardening (D), small fixes (F), the bigger follow-ups (G: outbox, metrics listener, app metrics), and test and CI gaps (E).                                                      |
| Commits     | One branch. A signed commit after each verified phase. Never pushed or merged without asking.                                                                                               |

**Success criteria**

- `libs/` names no domain, and the CI boundary check enforces it.
- A query that forgets a tenant or owner filter returns nothing it shouldn't. This is proven against real Postgres, for
  both the forbidden case (no rows) and the allowed case (the expected rows).
- Every documented rate limit behaves as written, proven by tests.
- After every phase these stay green: `bun run check`, all tests, the builds, both images, and the compose topologies.

## 2. Roadmap

| #   | Sub-project                                                                                                                              | Design gate              | Status             |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------ |
| A1  | Move to `domains/`, rename scopes, add the boundary check                                                                                | short (approved)         | **done** `1006b23` |
| H   | Patch/minor dependency bumps; Bun 1.4.3 pins                                                                                             | short                    | next               |
| D   | Production hardening (F01–F09, F33, RustFS and CORS guards)                                                                              | short                    |                    |
| F   | Small fixes (F20, F24, F25, F36)                                                                                                         | short                    |                    |
| B   | Ownership moves, tenancy, RLS, tenant isolation everywhere (F14, F18, staff bootstrap)                                                   | **this document + plan** |                    |
| C   | Rate limiting (F17 and the rate-limit gaps)                                                                                              | this document + plan     |                    |
| G   | Transactional outbox, metrics listener, app-level metrics, slimmer gateway image                                                         | this document + plan     |                    |
| E   | Real Socket.IO and graphql-ws specs, storage emulator specs, topology smoke test, `buf breaking`, drizzle check (F10–F13, F15, F16, F21) | short                    |                    |

B is built in four checkpoints. Each one is a signed commit with everything green:

1. **B1. Ownership moves.** No behaviour change apart from schema names.
2. **B2. Tenancy.** Data model, tokens, API and propagation; RLS not enforced yet.
3. **B3. RLS enforcement.** Roles, policies, the context adapter and the system pool.
4. **B4. Tenant isolation outside Postgres.** Cassandra, Redis, storage, WebSockets and GraphQL subscriptions.

## 3. Package architecture after B

### 3.1 Dependency rules

```text
apps/*            @app/*                  composition roots: wiring only
  │
  ▼
domains/<x>       @domain/<x>             one bounded context (domain, application, infrastructure, presentation)
domains/<x>/contracts  @domain/<x>-contracts  the context's published language: .proto, ts-proto output, event schemas
  │
  ▼
libs/*            @platform/*             platform adapters + shared kernel, no business rules
```

- A domain may import another domain **only through its `-contracts` package**. `scripts/check-boundaries.mjs` grows
  this rule.
- A domain or app that consumes an event, or calls a service, depends on the producer's contracts package, never on the
  producer. So service images ship only the contracts they use.
- `notifications` consumes identity and billing events, so it depends on `@domain/identity-contracts` and
  `@domain/billing-contracts`.
- The contracts packages are nested workspaces (`domains/*/contracts`). Bun's hoisted linker supports this; it was
  verified on a scratch workspace, including a filtered production install.
- **The one cross-domain GraphQL field.** `Payment.user` (billing payment → identity user) moves to the composition
  roots. `apps/monolith` and `apps/gateway` each register a small `PaymentUserFieldResolver` that uses identity's users
  DataLoader. Billing exposes only `userId`. This removes the `billing → identity` package edge that exists today.

### 3.2 What moves where (B1)

| From                                                                                             | To                                                                                                                        | Note                                                                                                                   |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `libs/contracts` per-domain protos, generated code, gRPC package specs, topics and event schemas | `domains/<x>/contracts`                                                                                                   | `libs/contracts` keeps only the generic envelope, headers, the topic-name helpers and buf config                       |
| `libs/transport`, which looks gRPC packages and topics up **by name** in a cross-domain registry | Takes **values**: a `GrpcPackageSpec` (plus client URL) and one event-contract object per topic, passed in by each domain | Removes the platform → domain coupling                                                                                 |
| `libs/config` `stripe` namespace; Stripe facade `libs/payments`                                  | `domains/billing/src/infrastructure/stripe/`                                                                              | `libs/payments` is deleted. The barrel collisions (`CreateCheckoutSessionInput`, `IDEMPOTENCY_KEY_REUSED`) get renamed |
| `libs/auth` `PasswordHasher` + the argon2 part of the `auth` namespace                           | `domains/identity/src/infrastructure/security/`                                                                           |                                                                                                                        |
| Token **issuance** (`issueAccessToken`, `issueRefreshToken`, `verifyRefreshToken`)               | identity                                                                                                                  | `libs/auth` keeps verification, guards and the denylist. A test-only signer ships as `@platform/auth/testing`          |
| Domain gRPC client URLs (`IDENTITY_GRPC_URL`, …)                                                 | each domain's `forRemote()` config                                                                                        | Same env var names                                                                                                     |
| File upload limits (`STORAGE_MAX_UPLOAD_BYTES`, `STORAGE_MAX_CONCURRENT_UPLOADS`)                | `domains/files`                                                                                                           | Same env var names                                                                                                     |
| Mail templates and their context types                                                           | the domain that sends them                                                                                                | `@platform/mailer` becomes template-agnostic: domains register template dirs                                           |
| `STRIPE_SIGNATURE`, `normalizeEmail`                                                             | billing, identity                                                                                                         |                                                                                                                        |
| Postgres migrations, `drizzle.config.ts`                                                         | each Postgres domain (section 4)                                                                                          |                                                                                                                        |
| Domain test fakes in apps (`in-memory-identity.ts`, `fake-upstreams.ts`)                         | a `./testing` subpath of the owning domain                                                                                |                                                                                                                        |
| `CONFIG_NAMESPACES` / `validateAllEnv`                                                           | platform namespaces only; domain namespaces are passed in by the caller                                                   | `scripts/check-env-example.mjs` also scans `domains/**/*.config.ts`                                                    |

## 4. Data ownership and migrations

- **One Postgres schema per domain.** `identity.*` and `billing.*`. A platform schema, `app`, holds the RLS helper
  functions. Tables leave `public`.
- **Migration sets.** Each domain has its own `drizzle.config.ts` and its own history, in
  `domains/<x>/src/infrastructure/persistence/migrations`, with a migrations table at `<schema>.__drizzle_migrations`.
  Separate tables matter: drizzle's migrator applies every file newer than the **last** timestamp in its table, so a
  shared table lets one domain silently skip another's files.
- **Order.** The call mirrors Cassandra's `migrations: [...]` option:
  `DatabaseModule.forRootAsync({ schema, migrations: [identityMigrations, billingMigrations] })`.
  - The sets run **in array order, under the one advisory lock**.
  - The **platform set always runs first and cannot be left out**. It creates the `app` schema, the helper functions,
    extensions and grants.
- **Three database roles.** Infrastructure creates them; schema files reference them with `pgRole(...).existing()`.

  | Role          | Attributes                                       | Used by                                                 | URL                      |
  | ------------- | ------------------------------------------------ | ------------------------------------------------------- | ------------------------ |
  | `app_owner`   | owns the schemas and tables                      | boot migrator, `db:migrate`, drizzle-kit, operator CLIs | `DATABASE_MIGRATION_URL` |
  | `app_runtime` | `NOSUPERUSER NOBYPASSRLS`, DML grants only       | every request                                           | `DATABASE_URL`           |
  | `app_system`  | `BYPASSRLS`, DML grants only, small pool (max 5) | the named system methods (section 9)                    | `DATABASE_SYSTEM_URL`    |
  - In compose, CI and the Testcontainers specs, the roles come from an init SQL script.
  - `docs/SECURITY.md` gives the production SQL.
  - Grants and default privileges are hand-written SQL in the platform set. drizzle-kit cannot express them.

- **`FORCE ROW LEVEL SECURITY`** is on every domain table, so even an owner connection is filtered.
  - Consequence: **migrations change schema only.** A data backfill, if one is ever needed, runs as `app_system` in a
    separate step.
- **Boot guard.** At startup `DatabaseModule` checks that the runtime connection is not a superuser, does not have
  `BYPASSRLS`, and does not own the tables. In production it refuses to start; elsewhere it logs a warning.
- **Fresh baselines.** Each domain's history starts at `0000_init`. Nothing is deployed, so local volumes need one
  `docker compose down -v`. The README says so.

## 5. Tenancy model (identity)

### 5.1 Tables

| Table                   | Columns (beyond `id uuidv7`, `created_at`)                                             | Notes                                                             |
| ----------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `identity.tenants`      | `slug` (unique), `name`, `personal`                                                    | The personal workspace is created at registration                 |
| `identity.memberships`  | `tenant_id`, `user_id`, `roles` (`tenant_role[]`), `last_active_at`                    | PK `(tenant_id, user_id)`; index `(user_id, last_active_at desc)` |
| `identity.invitations`  | `tenant_id`, `email`, `roles`, `token_hash`, `invited_by`, `expires_at`, `accepted_at` | Token: 32 random bytes, stored hashed; expires after 7 days       |
| `identity.audit_events` | `tenant_id`, `actor_id`, `type`, `data jsonb`                                          | Append-only. Covers staff switch-in, role changes, member removal |
| `identity.users`        | drops `roles`; adds `is_platform_staff`                                                | Users stay global                                                 |
| `identity.sessions`     | adds `tenant_id`                                                                       | A session belongs to one tenant                                   |
| `billing.payments`      | adds `tenant_id`                                                                       | Tenant-leading indexes and uniques                                |
| `billing.stripe_events` | adds `tenant_id`, `user_id` (from the signed event's metadata)                         | So the webhook runs under RLS (section 9)                         |

### 5.2 Flows

- **Register.** Create the user, the personal tenant (`"<name>'s workspace"`, slug derived from the email), an owner
  membership and a session for that tenant. The token pair carries `tid`.
- **Login.** Takes an optional `tenantId`, which must be one of the user's memberships. Without it, the most recently
  active membership wins.
- **Refresh.** Keeps the session's tenant.
- **Switch tenant** (`POST /v1/auth/switch-tenant { tenantId }`, plus a GraphQL mutation).
  - Requires a membership.
  - Opens a session for the target tenant, revokes the old session and denylists the old access token.
  - Returns a new token pair.
- **Staff switch-in** (`POST /v1/staff/tenants/:tenantId/switch-in { reason }`).
  - Requires `is_platform_staff`.
  - Issues an **access token only**: TTL `STAFF_SWITCH_IN_TTL_SEC`, default 900; `staff: true`; role `admin` in the
    target tenant; no refresh.
  - Writes an `audit_events` row in the target tenant, so the tenant can see it, and an audit log line.
- **Tenants.**
  - `GET /v1/tenants` lists mine.
  - `POST /v1/tenants` creates one, with me as owner.
  - `PATCH /v1/tenant` renames the active tenant (`tenant:manage`).
- **Members.**
  - `GET /v1/tenant/members`.
  - `PATCH /v1/tenant/members/:userId { roles }` (`members:manage`).
  - `DELETE /v1/tenant/members/:userId` (`members:manage`).
  - `POST /v1/tenant/leave`.
  - The last owner can't be removed or demoted. A per-tenant advisory lock replaces today's global last-admin lock.
- **Invitations.**
  - `POST /v1/tenant/invitations { email, roles }` (`members:manage`).
    - Identity sends the email itself, through `@platform/mailer` with its own template.
    - The raw token never travels through Kafka.
  - `POST /v1/invitations/accept { token }`.
    - The caller must be logged in, and their email must match the invitation.
- **Bootstrap.** `bun run --filter @domain/identity staff:grant <email>`.
  - Runs with `DATABASE_MIGRATION_URL` and sets `is_platform_staff`.
  - Replaces the manual SQL in `docs/SECURITY.md`.
- **GraphQL.** Mirrors the REST surface:
  - queries: `me` (user, active tenant, roles), `myTenants`, `tenantMembers`;
  - mutations: `switchTenant`, `createTenant`, `inviteMember`, `acceptInvitation`, `updateMemberRoles`, `removeMember`,
    `leaveTenant`.
- **gRPC.** `identity.v1` gains the matching RPCs. The gateway reaches them through `forRemote()`.

### 5.3 Tokens

- **Access token:** `sub`, `tid` (active tenant), `roles` (roles in `tid`), `jti`, `iat`, `exp`, `iss`, `aud`, plus
  `staff: true` on switch-in tokens.
- **Refresh token:** bound to the session row, and so to its tenant.
- **`email` claim:** stays, and gets documented (F26).

## 6. Authorization (RBAC)

- **Tenant roles:** `owner ⊇ admin ⊇ member`. Today's global `admin`/`moderator`/`user` become tenant roles;
  `moderator` folds into `admin`.
- **Open vocabulary.**
  - `@platform/auth` keeps the mechanism: guards, `@RequirePermissions`, `@Roles`.
  - Each domain declares its own permissions and default role grants with `RbacModule.forFeature({ permissions,
grants })`.
  - `AuthModule` assembles the role → permission map at boot.
  - No platform file names a domain permission.
- **Staff.** `@StaffOnly()` guards staff routes. F14 is resolved by using `@Roles()` where a role (not a permission) is
  the real requirement, or by dropping it from the README matrix.

## 7. Request principal and propagation

```ts
interface Principal {
  userId: string;
  tenantId: string | null; // null only in user-scoped units of work (e.g. picking a tenant at login)
  roles: TenantRole[];
  staff: boolean;
}
```

How the principal reaches each layer:

- **HTTP, GraphQL and Socket.IO edge.** `JwtAuthGuard` writes the principal into CLS (`CLS_PRINCIPAL`). Nothing does
  this today: `CLS_USER_ID` is never set at the edge.
- **Login and register.** These write the principal themselves, after their anonymous step (section 9).
- **gRPC.** The gateway forwards `x-tenant-id`, `x-user-id`, `x-user-roles` and `x-staff` on **every** call. Today only
  billing checkout sends a user, and nothing sends roles.
  - Services rebuild the principal in `GrpcContextInterceptor`, then recompute permissions from roles through the RBAC
    registry.
  - The metadata is trusted only inside the mesh: gRPC mTLS, or `GRPC_ALLOW_INSECURE` behind a mesh that does mTLS.
    `docs/SECURITY.md` says so.
- **Kafka.** The envelope gains `tenantId` (required for tenant-scoped events) and `actorId` (nullable).
  - Consumers put both into CLS.
  - A consumer that touches Postgres runs as the actor principal (`{ userId: actorId, tenantId }`).
  - Maintenance work runs in `SystemContext`.
  - Today's consumers only touch Cassandra.
- **Crons, the outbox relay and operator CLIs.** These run inside `SystemContext.run(fn)` (section 9).
- **GraphQL DataLoader batches.** These must keep the request's CLS context. A spec pins this down, because today it is
  unverified.

## 8. Row-level security

### 8.1 Mechanism

- **Context.** On `BEGIN`, the Drizzle transactional adapter sets three transaction-local settings in **one statement**
  from the CLS principal: `select set_config('app.user_id', $1, true), set_config('app.tenant_id', $2, true),
set_config('app.elevated', $3, true)`.
  - Transaction-local values cannot leak across pooled connections.
  - They work behind PgBouncer in transaction mode.
- **Helper functions.** These live in the `app` schema (platform set) and are used by every policy:
  - `app.user_id()` **raises** when unset: every runtime unit of work must have a user, so a missing context fails
    loudly instead of returning empty results.
  - `app.tenant_id()` returns `NULL` when unset (tenant-less units of work see no tenant rows).
  - `app.elevated()` returns a boolean.
  - Policies call each of them as `(select app.x())`, so it runs once per statement.
- **Unit of work.**
  - Every repository call goes through `txHost.withTransaction(Propagation.Required)`. It joins the handler's
    transaction if there is one; otherwise it opens one per call.
  - Multi-statement handlers wrap themselves, as several already do, so they pay the transaction overhead once.
  - The pool-bound prepared statements are removed. postgres.js still prepares every query per connection.
- **Elevation, instead of permission strings in SQL.**
  - A unit of work that legitimately reads other members' rows calls `elevate(permission)`. Examples: `billing:read-all`
    payments, member management, invitation acceptance.
  - It asserts **in TypeScript** that the principal holds the permission, then sets `app.elevated = on` for that
    transaction only, and logs it.
  - Policies check only the boolean, never a permission name, so a renamed permission can't drift away from its SQL.
  - Tenant isolation always holds: elevation never crosses tenants.

### 8.2 Policies

All policies are `PERMISSIVE`, and any table without a policy for the runtime role denies everything.

| Table                   | Read                                                              | Write                                                                                                                                                                                                 |
| ----------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `identity.users`        | `id = user_id()` **or** they share a membership in `tenant_id()`  | update: `id = user_id()`, and column grants keep `is_platform_staff` out of the runtime role's reach (only `staff:grant` sets it); insert: `id = user_id()` (register inserts "itself")               |
| `identity.tenants`      | `id = tenant_id()` **or** I hold a membership in it               | insert: `id = tenant_id()`; update: `id = tenant_id() and elevated()`                                                                                                                                 |
| `identity.memberships`  | `user_id = user_id()` **or** `tenant_id = tenant_id()`            | insert and update: `tenant_id = tenant_id() and elevated()`; delete: `tenant_id = tenant_id() and (elevated() or user_id = user_id())` (leaving deletes my own row, but nobody edits their own roles) |
| `identity.invitations`  | `tenant_id = tenant_id() and elevated()`                          | same                                                                                                                                                                                                  |
| `identity.sessions`     | `user_id = user_id()`                                             | same, plus `tenant_id = tenant_id()` on insert                                                                                                                                                        |
| `identity.audit_events` | `tenant_id = tenant_id() and elevated()`                          | insert: `tenant_id = tenant_id()`                                                                                                                                                                     |
| `billing.payments`      | `tenant_id = tenant_id() and (user_id = user_id() or elevated())` | insert and update: `tenant_id = tenant_id() and user_id = user_id()` (elevation reads, it never writes another member's payment)                                                                      |
| `billing.stripe_events` | `tenant_id = tenant_id() and user_id = user_id()`                 | insert: same                                                                                                                                                                                          |
| `<schema>.outbox` (G)   | none for runtime                                                  | insert: `tenant_id = tenant_id()`                                                                                                                                                                     |

### 8.3 The two named risks

1. **Silently empty results.**
   - The `users` policy checks `memberships`, which has its own policy. That is the one most likely to return `[]`
     where it should return rows or a 403.
   - Mitigations:
     - Every policy gets an integration spec covering **both** paths: the allowed case asserts the expected rows, not
       just a non-empty list, and the forbidden case asserts none.
     - `app.user_id()` raises when unset.
     - UPDATE and DELETE repository methods check the affected row count. Today `updateRoles`,
       `updatePasswordHash` and `revoke` ignore it.
2. **Overhead.**
   - A standalone repository call goes from 1 round trip to about 4: `BEGIN`, `set_config`, the query, `COMMIT`.
   - On a LAN that is about 1 ms. Handler-level transactions amortize it.
   - The k6 run is repeated before and after B3. A p95 regression above 10 % blocks the checkpoint until it is explained.
   - Connection hold time is unchanged in shape: no transaction ever spans an external call. The Stripe call already
     stays outside, and argon2 runs before the session insert.

## 9. Pre-auth and system access — **decided: option (b)**

Most flows that look anonymous today can run as a principal once the code is reordered:

- **Refresh:** verify the refresh JWT, then rotate the session as `{ sub, tid }`.
- **Login:** look up credentials, check the password, then rehash and open the session as the user.
- **Register:** insert the user under its own new id (the `users` insert policy allows `id = user_id()`), then the
  tenant, the membership and the session, all in **one** runtime transaction.
  - The owner membership is written with elevation. That is justified because the tenant was created in the same
    transaction.
  - `POST /v1/tenants` uses the same path.
- **Stripe webhook:** verify the signature, then act as the `{ userId, tenantId }` carried in the signed event's
  metadata. That is stronger than today: a webhook can't touch another tenant's payment.
- **Invitation acceptance:** after the token lookup, run as the accepting user in the invitation's tenant, with
  elevation justified by the verified token.

**What remains is the system surface.** These seven methods run without a principal:

1. `users.findCredentialsByEmail` (login lookup)
2. `users.existsByEmail` (register pre-check; the unique constraint still guards races)
3. `invitations.findByTokenHash` (accept lookup)
4. `sessions.deleteExpired` (hourly cron)
5. `stripeEvents.deleteProcessedBefore` (cleanup cron)
6. the outbox relay's claim and mark-published (G)
7. the `staff:grant` CLI (runs as `app_owner`)

**Options:**

- **(a) `SECURITY DEFINER` functions.** One SQL function per system method, owned by a bypass role; the runtime role may
  only `EXECUTE` them. Least privilege, but data access for these flows moves into SQL, outside Drizzle and the unit
  tests.
- **(b) A separate `BYPASSRLS` pool — chosen.** A `SYSTEM_DB` handle on `DATABASE_SYSTEM_URL` (pool max 5).
  Guardrails:
  - only files named `*.system-repository.ts` may inject it, and the boundary check enforces that;
  - every call is logged and counted;
  - the runtime pool can never bypass.

  The pattern matches Supabase's service role: explicit and easy to grep. The code stays in TypeScript and testable.

- **(c) A settable bypass flag** (`app.context = 'system'` checked in policies). Simplest, but weakest: anything that
  can run SQL can claim it, and every policy grows an `OR` branch.

## 10. Tenant isolation outside Postgres (B4)

- **Cassandra (notifications).** Partition keys become `(tenant_id, user_id)` for the inbox and the recipients
  projection. The digest runs per `(tenant, user)`. Isolation is enforced by key design and covered by tests; Cassandra
  has no RLS.
- **Redis.**
  - Cache keys for tenant-scoped data carry the tenant: `cache:<domain>:<tid>:…`.
  - The user cache stays user-keyed, but every read through it re-checks that the caller shares a tenant with that user.
  - Denylist and lock keys are unchanged.
- **Storage.**
  - Object keys become `tenants/<tid>/users/<uid>/<uuid>/<name>`.
  - Presign and download check the tenant prefix, plus ownership (or elevation for `files:manage`).
- **Socket.IO.** Rooms become `t:<tid>:u:<uid>`. A tenant switch closes the user's sockets for the old tenant.
- **GraphQL subscriptions.** Filters match tenant and user.
- **graphql-ws revocation (F18).** Sockets are tracked by `jti` and swept against the denylist, the same as Socket.IO
  (`WS_REVOCATION_SWEEP_INTERVAL_MS`).
- **Kafka.** The envelope carries `tenantId` and `actorId` (section 7).

## 11. Rate limiting (C)

- **Library.** Stay on `@nestjs/throttler` 6.7.1 with a custom `generateKey`. Keys are built from **scope** (throttler
  name plus scope key), not from class and handler names, which fixes F17.
- **Throttlers.**

  | Name     | Key                                                                            | Purpose                                                                                            |
  | -------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
  | `ip`     | client IP (trusted-proxy aware everywhere, including graphql-ws and Socket.IO) | generous pre-auth flood cap; runs **before** JWT parsing, so 401/403 floods are counted            |
  | `user`   | principal user, falling back to IP                                             | the global per-user budget across all routes                                                       |
  | `tenant` | principal tenant                                                               | aggregate budget, so one noisy tenant can't starve others                                          |
  | `auth`   | `sha256(normalized email)` plus IP                                             | credential endpoints, shared by REST and GraphQL, with a failure-based lockout counter per account |

- **Policies.** Domains declare named route policies (e.g. `identity.credentials`, `files.upload`) through a registry,
  used as `@RateLimit('identity.credentials')`. Limits come from env, documented in `CONFIGURATION.md`.
- **GraphQL.** Limited **per operation**, not per root field, in an Apollo plugin.
  - Cost is weighted by the complexity score the existing plugin already computes.
  - A fully limited operation returns HTTP 429.
  - The graphql-ws path also runs the complexity check.
- **Responses.**
  - IETF `RateLimit-Policy` and `RateLimit` headers plus `Retry-After`, also on 429s, and exposed through CORS.
  - Socket.IO errors (429 and all others) are delivered as `{ ok: false, error }` acks and `exception` events. Today
    WebSocket gateways don't receive the global filter at all.
- **Connections.** Caps on concurrent sockets per user and handshakes per IP, for both Socket.IO and graphql-ws.
- **Redis down.**
  - Budgets **fail open**, with a metric and a bounded command timeout.
  - The `auth` throttler **fails closed** (503).

## 12. Bigger follow-ups (G)

- **Transactional outbox.**
  - Each domain gets a table, `<schema>.outbox`, with columns `id`, `tenant_id`, `topic`, `key`, `envelope`,
    `created_at` and `published_at`.
  - Rows are written in the same runtime transaction as the change.
  - A relay in each process that owns the domain claims rows through the system pool, using `FOR UPDATE SKIP LOCKED`
    batches, publishes them, then marks them published.
  - Delivery becomes at-least-once; consumers already dedupe by envelope id. This replaces the publish-after-commit
    relays.
- **Metrics listener.** `/metrics` moves to `METRICS_PORT` (default 9464) on a separate listener and leaves the API port.
- **App-level metrics.**
  - gRPC client and server calls, latency and status;
  - circuit-breaker state;
  - Kafka consumer lag and handler outcomes;
  - DB pool in-use and waiting;
  - outbox backlog and publish latency;
  - rate-limit decisions.
- **Gateway image.**
  - Each domain gets an `./api` subpath entry: presentation, ports and remote adapters, without core or persistence.
  - `assemble-image.mjs` copies only the files reachable from the app's entrypoint, using file tracing.
  - A subpath export alone doesn't shrink the image today, because whole `dist/` folders are copied.

## 13. Testing strategy

- **RLS integration specs.** They run on Testcontainers Postgres, with the three roles created by the same init SQL as
  compose. For every policy they cover:
  - the allowed path (expected rows);
  - cross-user and cross-tenant attempts (no rows, or a write rejected by the policy);
  - a missing context (the helper raises);
  - elevation (only after the permission check).
- **Tenancy end-to-end specs** in both topologies:
  - register → personal tenant;
  - invite → accept → switch tenant;
  - staff switch-in (and its audit row);
  - last-owner protection;
  - isolation of payments, notifications and files between two tenants.
- **Fakes.** The in-memory fakes in `./testing` subpaths learn tenancy, so app end-to-end tests stay fast.
- **Real connections.** The real-connection Socket.IO and graphql-ws specs (E) cover tenant rooms and revocation.
- **Load.** The k6 baseline is taken before B3 and compared after it.

## 14. Risks

| Risk                                                        | Mitigation                                                                                                                    |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| RLS returns empty results instead of errors                 | Fail-loud `app.user_id()`; both-path integration specs; row-count checks                                                      |
| Overhead per database call                                  | Handler-level transactions; one `set_config` statement; k6 gate at B3                                                         |
| gRPC principal metadata is unsigned                         | Trusted only inside the mesh (mTLS); documented. Signed principal headers are a possible later hardening                      |
| B is large                                                  | Four checkpoints, each with a signed commit and all gates green                                                               |
| drizzle-kit can't model `FORCE RLS`, `GRANT` or `BYPASSRLS` | Hand-written SQL in the platform set and the domain baselines; the CI drift check still passes because snapshots don't change |
| Local data reset                                            | One `docker compose down -v` after B1; called out in the README and the PR description                                        |

## 15. Out of scope

- Plan-based quotas.
- Per-tenant schemas or databases.
- SSO/SAML.
- Tenant deletion and data export.
- Cross-tenant staff search: staff only switch in.
- RLS for Cassandra: isolation there is by key design.

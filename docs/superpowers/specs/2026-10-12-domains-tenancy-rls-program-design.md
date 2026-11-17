# Program design: domain layout, multi-tenancy with RLS, rate limiting, hardening

- **Status:** approved 2026-10-12, with option (b) for system access (section 9).
- **Branch:** `feat/domains-tenancy`
- **Date:** 2026-10-12
- **Amended:** 2026-11-09 with Citus + PgBouncer sharding and the Stripe/immudb ledger; every change is listed in
  section 16.
- **Amended:** 2026-11-17 (B3): identity policies are row-local and the directory reads moved to the system pool;
  see sections 8.2 and 9 and the delta in section 16.

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

## 2. Roadmap (amended 2026-11-09; see the [sharding design](2026-11-09-sharding-citus-pgbouncer-design.md) section 8 and the [ledger design](2026-11-09-stripe-ledger-immudb-design.md) section 8)

| #   | Sub-project                                                                                                                              | Design gate                                                             | Status                                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------- |
| A1  | Move to `domains/`, rename scopes, add the boundary check                                                                                | short (approved)                                                        | **done** `1006b23`                                         |
| H   | Patch/minor dependency bumps; Bun 1.4.3 pins                                                                                             | short                                                                   | **done** `7040115`                                         |
| D   | Production hardening (F01–F09, F33, RustFS and CORS guards)                                                                              | short                                                                   | **done** `74f70b7`, `0505e92`                              |
| F   | Small fixes (F20, F24, F25, F36)                                                                                                         | short                                                                   | **done** `75c477a`                                         |
| B   | Ownership moves, tenancy, RLS, tenant isolation everywhere (F14, F18, staff bootstrap)                                                   | **this document + plan**                                                | B1 **done** (`069cd56`, final fixes to `9600510`); B2 next |
| S   | Citus 14.2 sharding + PgBouncer 1.26 (SH-1..SH-12)                                                                                       | [sharding design](2026-11-09-sharding-citus-pgbouncer-design.md) + plan | S0 (SH-1..SH-4) next, before B2 executes                   |
| L   | Stripe idempotency end to end, immudb double-entry ledger, reconciliation (L-1..L-15)                                                    | [ledger design](2026-11-09-stripe-ledger-immudb-design.md) + plan       | wave 0 next, in parallel with B2                           |
| C   | Rate limiting (F17 and the rate-limit gaps)                                                                                              | this document + plan                                                    |                                                            |
| G   | Transactional outbox, metrics listener, app-level metrics, slimmer gateway image                                                         | this document + plan                                                    |                                                            |
| E   | Real Socket.IO and graphql-ws specs, storage emulator specs, topology smoke test, `buf breaking`, drizzle check (F10–F13, F15, F16, F21) | short                                                                   |                                                            |

B is built in four checkpoints. Each one is a signed commit with everything green:

1. **B1. Ownership moves.** No behaviour change apart from schema names.
2. **B2. Tenancy.** Data model, tokens, API and propagation; RLS not enforced yet.
3. **B3. RLS enforcement.** Roles, policies, the context adapter and the system pool.
4. **B4. Tenant isolation outside Postgres.** Cassandra, Redis, storage, WebSockets and GraphQL subscriptions.

Phases S and L slot into B and G as follows (task ids from the two design docs):

- **S (Citus + PgBouncer).**
  - **S0 = SH-1..SH-4, before B2 executes:** the Citus image in compose, Testcontainers (`@platform/testing/postgres`)
    and CI; the platform distribution helpers and the runner's sequential mode; the Citus-ready schema rules.
  - **SH-5 / SH-6** (identity and billing distribution migrations) right after the B2 table tasks (B2-1..B2-5, B2-6).
  - **SH-7..SH-10** inside B3: `SET LOCAL` context in B3-7, role settings in B3-2, PgBouncer with B3-3, the boot
    guard addition with B3's boot guard.
  - **SH-11** (worker profile, sharding smoke spec) after B3. **SH-12** in the final squash.
- **L (Stripe idempotency + immudb ledger + reconciliation).**
  - **Wave 0, now** (in parallel with B2; touches no tenant column and no billing migration): L-1..L-9.
  - **Wave 1** after B2-6, B3 (B3-6, B3-10, B3-11) and G-1, G-2: L-10, L-11.
  - **Wave 2** after G-3 and G-4: L-12..L-15.
- **Final squash** (program decision): each domain's stacked migrations fold into a fresh `0000_init`, keeping the
  hand-written SQL (RLS, grants, distribution calls).

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

## 4. Data ownership and migrations (amended 2026-11-09; see the sharding design sections 2, 4, 5 and 7.3)

- **One Postgres schema per domain.** `identity.*` and `billing.*`. A platform schema, `app`, holds the RLS helper
  functions and the Citus distribution helpers. Tables leave `public`. (A policy helper that names a domain table was
  planned here; B3 found it cannot work on Citus, so no policy calls one: see section 8.2.)
- **Citus 14.2 everywhere** (compose, Testcontainers, CI); plain Postgres is an unsupported fallback, on which the
  distribution helpers are no-ops. Every table is exactly one **kind**:

  | Kind                       | Rule                                                                                                                                            | Tables                                                                                                                                                                                                  |
  | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | reference                  | global, small, read-mostly, replicated to every node                                                                                            | `identity.users`, `identity.tenants`, `identity.memberships`                                                                                                                                            |
  | distributed by `tenant_id` | `tenant_id uuid NOT NULL`, colocated with `app.tenant_colocation`; the PK and every unique lead with `tenant_id` (usually PK `(tenant_id, id)`) | `identity.invitations`, `identity.audit_events`, `billing.payments`, `billing.stripe_events`, `<schema>.outbox`, `billing.ledger_accounts`, `billing.ledger_entry_refs`, `billing.ledger_discrepancies` |
  | distributed by `user_id`   | own colocation group; PK `(user_id, id)`                                                                                                        | `identity.sessions`                                                                                                                                                                                     |
  | coordinator-local          | bookkeeping and system-only tables                                                                                                              | `<schema>.__drizzle_migrations`, `billing.ledger_reconciliation_runs`, `billing.ledger_trusted_state`                                                                                                   |
  - **FKs.** Distributed → reference is allowed (with `ON DELETE CASCADE`); distributed → distributed only between
    colocated tables and including the distribution column; never reference → distributed, never to or from a
    coordinator-local table. **No FK crosses a domain schema**: `tenant_id` and `user_id` in billing are plain columns.
  - **Distribution calls** (`app.make_reference`, `app.distribute_by_tenant`, `app.distribute_by_user`) live in one
    custom migration per domain right after the B2 table tasks (SH-5 identity, SH-6 billing). A table created later
    (G-1 outbox, L-10 ledger tables) is distributed inline, right after its `CREATE TABLE`.
  - Every tenant-scoped repository query also carries an explicit `tenant_id = $param` predicate, for shard routing.
    RLS stays the guarantee.

- **Migration sets.** Each domain has its own `drizzle.config.ts` and its own history, in
  `domains/<x>/src/infrastructure/persistence/migrations`, with a migrations table at `<schema>.__drizzle_migrations`.
  Separate tables matter: drizzle's migrator applies every file newer than the **last** timestamp in its table, so a
  shared table lets one domain silently skip another's files.
- **Order.** The call mirrors Cassandra's `migrations: [...]` option:
  `DatabaseModule.forRootAsync({ schema, migrations: [identityMigrations, billingMigrations] })`.
  - The sets run **in array order, under the one advisory lock**.
  - The **platform set always runs first and cannot be left out**. It creates the `app` schema, the helper functions,
    extensions and grants.
  - **Migrations connect directly to the Citus coordinator**, never through PgBouncer (the session advisory lock
    needs a direct connection). When the `citus` extension exists, the runner sets
    `citus.multi_shard_modify_mode = 'sequential'` on its private `max: 1` connection, because drizzle applies all
    pending files of a set in one transaction.
- **Three database roles.** Infrastructure creates them; schema files reference them with `pgRole(...).existing()`.

  | Role          | Attributes                                       | Used by                                                 | URL                      | Through                 | Server settings (`ALTER ROLE … SET`)                                                                             |
  | ------------- | ------------------------------------------------ | ------------------------------------------------------- | ------------------------ | ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
  | `app_owner`   | owns the schemas and tables                      | boot migrator, `db:migrate`, drizzle-kit, operator CLIs | `DATABASE_MIGRATION_URL` | direct coordinator      | none (the migrator sets sequential mode itself)                                                                  |
  | `app_runtime` | `NOSUPERUSER NOBYPASSRLS`, DML grants only       | every request                                           | `DATABASE_URL`           | PgBouncer (transaction) | `citus.propagate_set_commands = 'local'`, `statement_timeout = 15s`, `idle_in_transaction_session_timeout = 60s` |
  | `app_system`  | `BYPASSRLS`, DML grants only, small pool (max 5) | the named system methods (section 9)                    | `DATABASE_SYSTEM_URL`    | PgBouncer (transaction) | same as `app_runtime`                                                                                            |
  - In compose, CI and the Testcontainers specs, the roles come from an init SQL script.
  - `docs/SECURITY.md` gives the production SQL.
  - Grants and default privileges are hand-written SQL in the platform set. drizzle-kit cannot express them.
  - The role settings live in the shared init SQL and `docs/SECURITY.md`, not in migrations. The timeouts move there
    because PgBouncer rejects them as startup parameters; with `DATABASE_POOLER=pgbouncer` the client stops sending
    them.

- **`FORCE ROW LEVEL SECURITY`** is on every domain table, so even an owner connection is filtered.
  - Consequence: **migrations change schema only.** A data backfill, if one is ever needed, runs as `app_system` in a
    separate step.
- **Boot guard.** At startup `DatabaseModule` checks that the runtime connection is not a superuser, does not have
  `BYPASSRLS`, and does not own the tables. In production it refuses to start; elsewhere it logs a warning. On Citus
  it also requires `citus.propagate_set_commands = 'local'` for the runtime connection.
- **Fresh baselines.** Each domain's history starts at `0000_init`. Nothing is deployed, so local volumes need one
  `docker compose down -v`. The README says so. During the program, schema changes stack as numbered migrations
  (the next free `NNNN` per set at merge time; billing's set stays serialized on one lane); a final task squashes
  each domain into a fresh `0000_init` that keeps the hand-written SQL (RLS, grants, distribution calls).

## 5. Tenancy model (identity)

### 5.1 Tables (amended 2026-11-09; see the sharding design section 2.3 and the ledger design sections 5 and 8.1)

Kinds (section 4): R = reference, T = distributed by `tenant_id`, U = distributed by `user_id`, L = coordinator-local.
`id` is `uuid DEFAULT uuidv7()` and `created_at` is `timestamp(3) with time zone DEFAULT now() NOT NULL` unless stated.

| Table                                       | Kind | Columns (beyond `id uuidv7`, `created_at`)                                                                                                                                                                            | PK / uniques / indexes                                                                                                                             | FKs                                                                      | Notes                                                                                                                                                 |
| ------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `identity.tenants`                          | R    | `slug text NOT NULL`, `name text NOT NULL`, `personal boolean NOT NULL DEFAULT false`                                                                                                                                 | PK `(id)`; unique `tenants_slug_unique (slug)`; CHECK `tenants_id_not_platform (id <> '00000000-0000-0000-0000-000000000000')`                     | –                                                                        | The personal workspace is created at registration. The nil UUID is `PLATFORM_TENANT_ID`, never a tenant                                               |
| `identity.memberships`                      | R    | `tenant_id uuid NOT NULL`, `user_id uuid NOT NULL`, `roles identity.tenant_role[] NOT NULL`, `last_active_at timestamptz(3)`; no `id`                                                                                 | PK `(tenant_id, user_id)`; index `(user_id, last_active_at desc)`                                                                                  | `tenant_id → tenants.id`, `user_id → users.id`, both `ON DELETE CASCADE` |                                                                                                                                                       |
| `identity.invitations`                      | T    | `tenant_id uuid NOT NULL`, `email text NOT NULL`, `roles identity.tenant_role[] NOT NULL`, `token_hash text NOT NULL`, `invited_by uuid NOT NULL`, `expires_at timestamptz(3) NOT NULL`, `accepted_at timestamptz(3)` | PK `(tenant_id, id)`; unique `invitations_tenant_id_token_hash_uq (tenant_id, token_hash)`; index `invitations_token_hash_idx (token_hash)`        | `tenant_id → tenants.id ON DELETE CASCADE`, `invited_by → users.id`      | Token: 32 random bytes, stored hashed; expires after 7 days. `findByTokenHash` is a multi-shard system read                                           |
| `identity.audit_events`                     | T    | `tenant_id uuid NOT NULL`, `actor_id uuid` (no FK), `type text NOT NULL`, `data jsonb NOT NULL DEFAULT '{}'`                                                                                                          | PK `(tenant_id, id)`; index `(tenant_id, created_at desc)`                                                                                         | `tenant_id → tenants.id ON DELETE CASCADE`                               | Append-only. Covers staff switch-in, role changes, member removal                                                                                     |
| `identity.users`                            | R    | drops `roles`; adds `is_platform_staff boolean NOT NULL DEFAULT false`                                                                                                                                                | PK `(id)`; unique `users_email_unique (email)`; trigram GIN index kept                                                                             | –                                                                        | Users stay global                                                                                                                                     |
| `identity.sessions`                         | U    | adds `tenant_id uuid NOT NULL`; `id` has no default (it is the refresh `jti`); `replaced_by_id` stays a plain uuid                                                                                                    | PK `sessions_user_id_id_pk (user_id, id)` (was `(id)`); index `(expires_at)`                                                                       | `user_id → users.id`, `tenant_id → tenants.id`, both `ON DELETE CASCADE` | A session belongs to one tenant. Refresh looks up `(user_id = sub, id = jti)`: a router query                                                         |
| `billing.payments`                          | T    | adds `tenant_id uuid NOT NULL`, `request_hash text` (nullable; S-2); status enum gains `refunded`, `partially_refunded`, `disputed` (S-6)                                                                             | PK `(tenant_id, id)`; uniques `(tenant_id, stripe_checkout_session_id)`, `(tenant_id, user_id, idempotency_key)`; index `(tenant_id, user_id, id)` | none (no cross-domain FK)                                                | Replaces `payments_user_id_id_idx`, `payments_user_id_idempotency_key_uq` and the global checkout-session unique                                      |
| `billing.stripe_events`                     | T    | adds `tenant_id uuid NOT NULL`, `user_id uuid` (**nullable**), both from the signed event's metadata                                                                                                                  | PK `(tenant_id, id)` (`id` stays the Stripe event id, `text`); index `(processed_at)`                                                              | none                                                                     | So the webhook runs under RLS (section 9). Platform-level events (`payout.*`) use `PLATFORM_TENANT_ID` and `user_id` NULL, written by a system method |
| `<schema>.outbox` (G-1)                     | T    | `tenant_id uuid NOT NULL`, `topic`, `key`, `envelope`, `published_at` (section 12)                                                                                                                                    | PK `(tenant_id, id)`                                                                                                                               | none                                                                     | Distributed inline by G-1                                                                                                                             |
| `billing.ledger_accounts` (L-10)            | T    | `tenant_id uuid NOT NULL`, `code text`, `currency text`, `immudb_account_id uuid`; no `id`                                                                                                                            | PK `(tenant_id, code, currency)`                                                                                                                   | none                                                                     | Platform accounts use `PLATFORM_TENANT_ID`                                                                                                            |
| `billing.ledger_entry_refs` (L-10)          | T    | `tenant_id uuid NOT NULL`, `entry_id uuid`, `source_key`, `payload_hash`, `immudb_tx_id bigint`, `payment_id`, `kind`, `posted_at`; no `id`                                                                           | PK `(tenant_id, entry_id)`                                                                                                                         | none (`payment_id` plain)                                                | Append-only receipt of each immudb posting                                                                                                            |
| `billing.ledger_discrepancies` (L-10)       | T    | `tenant_id uuid NOT NULL`, `kind`, `source_key`, `expected jsonb`, `actual jsonb`, `detected_by`, `run_id`, `resolves_id`                                                                                             | PK `(tenant_id, id)`                                                                                                                               | none (`run_id`, `resolves_id` plain: no FK to a local table)             | Append-only: no UPDATE/DELETE grant; a resolution is a new row                                                                                        |
| `billing.ledger_reconciliation_runs` (L-10) | L    | `from_ts`, `to_ts`, `status`, `counts jsonb`, `finished_at`                                                                                                                                                           | PK `(id)`                                                                                                                                          | none                                                                     | System pool only                                                                                                                                      |
| `billing.ledger_trusted_state` (L-10)       | L    | `database text`, `tx_id bigint`, `tx_hash bytea`, `verified_at`; no `id`                                                                                                                                              | PK `(database)`                                                                                                                                    | none                                                                     | System pool only                                                                                                                                      |

The exact B2 DDL is in the sharding design section 2.3 ("Exact B2 SQL shapes"). In Drizzle, T and U tables use
`primaryKey({ columns: [t.tenantId, t.id] })` (or `[t.userId, t.id]`); `uuid().primaryKey()` alone is not valid on
them. B2-26 puts `{ paymentId, userId, tenantId }` in both the Checkout session metadata and
`payment_intent_data.metadata`.

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

### 8.1 Mechanism (amended 2026-11-09; see the sharding design sections 7.1 and 7.3)

- **Context.** On `BEGIN`, the Drizzle transactional adapter sets three transaction-local settings in **one
  simple-protocol round trip**, from the CLS principal: `SET LOCAL app.user_id = '<uuid>'; SET LOCAL
app.tenant_id = '<uuid or empty>'; SET LOCAL app.elevated = 'on|off'` (sent with `tx.unsafe(sql).simple()`).
  - Values are never bound parameters (`SET` takes none). The adapter builds the string only from values that pass
    a strict UUID regex; anything else throws before SQL is sent. `PLATFORM_TENANT_ID` (the nil UUID) is refused as a
    runtime tenant.
  - `set_config()` is not used: Citus propagates `SET LOCAL` to the worker connections of the transaction (the role
    default `citus.propagate_set_commands = 'local'` on `app_runtime` and `app_system`), but never `set_config()`.
  - Transaction-local values cannot leak across pooled connections, and they work behind PgBouncer in transaction
    mode.
  - `elevate(permission)` issues `SET LOCAL app.elevated = 'on'` mid-transaction; Citus propagates it to connections
    that are already open.
- **Role settings.** `ALTER ROLE app_runtime SET citus.propagate_set_commands = 'local'` (and the same for
  `app_system`), plus `statement_timeout` and `idle_in_transaction_session_timeout` through `ALTER ROLE … SET`,
  because PgBouncer rejects them as startup parameters (section 4).
- **Helper functions.** These live in the `app` schema (platform set) and are used by every policy:
  - `app.user_id()` **raises** when unset: every runtime unit of work must have a user, so a missing context fails
    loudly instead of returning empty results.
  - `app.tenant_id()` returns `NULL` when unset (tenant-less units of work see no tenant rows).
  - `app.elevated()` returns a boolean.
  - Policies call each helper directly (`app.tenant_id()`, never `(select app.tenant_id())`). Citus rejects
    subqueries in policies. The helpers are `STABLE`, and `user_id()`/`tenant_id()` read
    `nullif(current_setting(…, true), '')`.
- **No cross-table policy checks** (amended 2026-11-17: B3 ruling `b3-identity-policies`). A helper that reads another
  table fails on a shard under Citus, so every policy is row-local (section 8.2).
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

### 8.2 Policies (amended 2026-11-09; see the sharding design section 7.2 and the ledger design section 5)

All policies are `PERMISSIVE`, and any table without a policy for the runtime role denies everything.

- **No subqueries in any policy expression** (Citus rejects them on distributed and reference tables): call
  `app.user_id()`, `app.tenant_id()` and `app.elevated()` directly; `user_id()` etc. below are those calls.
- **Policies are row-local** (amended 2026-11-17, B3 ruling `b3-identity-policies`; it replaces the 2026-11-09
  cross-table helpers `identity.shares_current_tenant` and `identity.is_member`, which were never shipped). A policy
  uses only the row's own columns and the session helpers `app.user_id()`, `app.tenant_id()` and `app.elevated()` (all
  read `current_setting`). No policy, and no function a policy calls, reads a table. Reason: Citus 14.2 with
  `citus.enable_local_execution=off` (cluster behaviour) fails any policy that calls a helper reading another distributed
  table as `app_runtime`, with `XX000 cannot execute a distributed query from a query on a shard`. That covers
  `identity.shares_current_tenant`, `identity.is_member` and `identity.staff_flag`, even though `memberships` is a
  reference table. Not accepted as fixes: `citus.allow_nested_distributed_execution` ("possible incorrectness") and
  running the policy specs with local execution on (it hides the cluster failure).
- **Trust model.** What a policy can no longer say moves to application SQL. Co-member reads (the member directory,
  scoped `GET /v1/users/:id`) and reads of the caller's tenants outside the session tenant run on the system pool
  (section 9), with the scoping filter written in the SQL itself. They are verified in application SQL, not by the
  database policy: the same trust model as the session context itself.
- A column-level `INSERT` grant on `identity.users` also fails on Citus (the shard `INSERT` lists every defaulted column,
  so `is_platform_staff` needs `INSERT` privilege). The `UPDATE` column list works. So `INSERT` is table-level and the
  `WITH CHECK` refuses `is_platform_staff = true`.
- Rows with `tenant_id = PLATFORM_TENANT_ID` never match a runtime policy (no runtime principal carries the nil UUID);
  only the system pool reads or writes them.

| Table                                                                | Read                                                              | Write                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `identity.users`                                                     | `id = user_id()`                                                  | insert: table-level `INSERT` grant, `WITH CHECK (id = user_id() AND NOT is_platform_staff)` (register inserts "itself"); update: `USING` and `WITH CHECK (id = user_id())`, column grants keep `is_platform_staff` out of the runtime role's reach (only `staff:grant` sets it, as `app_owner` through two `TO app_owner` policies) |
| `identity.tenants`                                                   | `id = tenant_id()`                                                | insert: `id = tenant_id()`; update: `id = tenant_id() and elevated()`                                                                                                                                                                                                                                                               |
| `identity.memberships`                                               | `user_id = user_id()` **or** `tenant_id = tenant_id()`            | insert and update: `tenant_id = tenant_id() and elevated()`; delete: `tenant_id = tenant_id() and (elevated() or user_id = user_id())` (leaving deletes my own row, but nobody edits their own roles)                                                                                                                               |
| `identity.invitations`                                               | `tenant_id = tenant_id() and elevated()`                          | same                                                                                                                                                                                                                                                                                                                                |
| `identity.sessions`                                                  | `user_id = user_id()`                                             | same, plus `tenant_id = tenant_id()` on insert                                                                                                                                                                                                                                                                                      |
| `identity.audit_events`                                              | `tenant_id = tenant_id() and elevated()`                          | insert: `tenant_id = tenant_id()`                                                                                                                                                                                                                                                                                                   |
| `billing.payments`                                                   | `tenant_id = tenant_id() and (user_id = user_id() or elevated())` | insert and update: `tenant_id = tenant_id() and user_id = user_id()` (elevation reads, it never writes another member's payment)                                                                                                                                                                                                    |
| `billing.stripe_events`                                              | `tenant_id = tenant_id() and user_id = user_id()`                 | insert: same (platform rows, `user_id` NULL, only through the system pool)                                                                                                                                                                                                                                                          |
| `<schema>.outbox` (G)                                                | none for runtime                                                  | insert: `tenant_id = tenant_id()`                                                                                                                                                                                                                                                                                                   |
| `billing.ledger_accounts` (L-10)                                     | `tenant_id = tenant_id() and elevated()`                          | insert: `tenant_id = tenant_id()`                                                                                                                                                                                                                                                                                                   |
| `billing.ledger_entry_refs` (L-10)                                   | `tenant_id = tenant_id() and elevated()`                          | insert: `tenant_id = tenant_id()`; no update or delete                                                                                                                                                                                                                                                                              |
| `billing.ledger_discrepancies` (L-10)                                | `tenant_id = tenant_id() and elevated()`                          | insert: `tenant_id = tenant_id()`; `UPDATE` and `DELETE` revoked                                                                                                                                                                                                                                                                    |
| `billing.ledger_reconciliation_runs`, `billing.ledger_trusted_state` | none for runtime (system only)                                    | none for runtime                                                                                                                                                                                                                                                                                                                    |

### 8.3 The two named risks (amended 2026-11-09; see the sharding design section 7.1)

1. **Silently empty results.**
   - A policy that returned `[]` where a flow expects rows is the failure to watch for (amended 2026-11-17: no policy
     reads another table any more, so a policy no longer depends on another table's policy). The reads that need more
     than the row's own columns are system methods, which return rows by their own SQL filter.
   - Mitigations:
     - Every policy gets an integration spec covering **both** paths: the allowed case asserts the expected rows, not
       just a non-empty list, and the forbidden case asserts none.
     - `app.user_id()` raises when unset.
     - UPDATE and DELETE repository methods check the affected row count. Today `updateRoles`,
       `updatePasswordHash` and `revoke` ignore it.
2. **Overhead.**
   - A standalone repository call goes from 1 round trip to about 4: `BEGIN`, the `SET LOCAL` string, the query,
     `COMMIT`.
   - On a LAN that is about 1 ms. Handler-level transactions amortize it.
   - The k6 run is repeated before and after B3. A p95 regression above 10 % blocks the checkpoint until it is explained.
   - Connection hold time is unchanged in shape: no transaction ever spans an external call. The Stripe call already
     stays outside, and argon2 runs before the session insert.

## 9. Pre-auth and system access — **decided: option (b)** (amended 2026-11-09; see the sharding design section 7.4 and the ledger design sections 3 and 5)

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
  - Platform-level events (`payout.*`, unattributed fees) carry no user or tenant: they are recorded through system
    method 8 with `tenant_id = PLATFORM_TENANT_ID` and `user_id` NULL.
  - The ledger's `billing.ledger-posting.v1` consumer runs as the envelope's `{ userId, tenantId }` when both are set,
    and in `SystemContext` (system method 10) for platform or user-less messages.
- **Invitation acceptance:** after the token lookup, run as the accepting user in the invitation's tenant, with
  elevation justified by the verified token.

**What remains is the system surface.** These methods run without a principal (1-7 from the original design, 8-11
added by the ledger design):

1. `users.findCredentialsByEmail` (login lookup)
2. `users.existsByEmail` (register pre-check; the unique constraint still guards races)
3. `invitations.findByTokenHash` (accept lookup; a multi-shard read on Citus, one index probe per shard)
4. `sessions.deleteExpired` (hourly cron; a multi-shard `DELETE` without row locks)
5. `stripeEvents.deleteProcessedBefore` (cleanup cron; same)
6. the outbox relay's poll and mark-published (G). Under Citus there is no claim with `FOR UPDATE SKIP LOCKED`
   (unsupported across shards): see section 12.
7. the `staff:grant` CLI (runs as `app_owner`, directly on the coordinator)
8. `stripeEvents.markProcessedAsPlatform` and `outbox.insertAsPlatform` (platform-level webhooks such as `payout.*`)
9. `ledgerReconciliation.listSucceededPayments(from, to, cursor)` and `listEntryRefs(from, to, cursor)` (cross-tenant
   reads for reconciliation R3, keyset by `(tenant_id, id)`)
10. `ledgerReconciliation.appendDiscrepancies(rows)`, `enqueueMissingPostings(rows)` and
    `ledgerEntryRefs.recordAsSystem(rows)` (cross-tenant writes, and the ledger consumer's rows for platform or
    user-less postings)
11. `ledgerTrustedState.read(database)` / `advance(database, from, to)` and `ledgerRuns.start/finish`

**Added by B3 (ruling `b3-identity-policies`, 2026-11-17):** with the row-local identity policies (section 8.2), the
co-member and cross-tenant reads are `system`-scope methods (inside `SystemContext.run(reason, …)`), each asserted by its
caller and filtered in its SQL:

12. `users.findByIdInTenant` (scoped `GET /v1/users/:id`, scoped `UsersPort` reads) and `users.listInTenant` (`ListUsers`):
    `users JOIN memberships ON tenant_id = <the caller's tenant>`; reason `identity.user-directory`
13. `memberships.findMember` (the member and profile after a role change) and `memberships.listMembers` (`ListMembers`,
    GraphQL `tenantMembers`): reason `identity.member-directory`
14. `memberships.listForUser` (`ListMyTenants`): every membership of the caller, across tenants; reason
    `identity.my-tenants`. Login tenant selection, switch tenant, refresh and accept invitation read the caller's own
    membership rows on the runtime path instead, which the `memberships` policy allows (`user_id = user_id()`).

Methods 1-3 are `pre-auth` scope (they run before any principal exists); 4, 5, 8, 12-14 are `system` scope. The pinned
lists in `identity.system-methods.ts` and `billing.system-methods.ts` and the table in `docs/SECURITY.md` name them.

The system pool goes through PgBouncer like the runtime pool (system methods use no session state). The sharding
design adds no system method.

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

## 12. Bigger follow-ups (G) (amended 2026-11-09; see the sharding design section 7.4 and the ledger design section 3)

- **Transactional outbox.**
  - Each domain gets a table, `<schema>.outbox`, with columns `id`, `tenant_id`, `topic`, `key`, `envelope`,
    `created_at` and `published_at`. It is distributed by `tenant_id` with PK `(tenant_id, id)`; G-1 distributes it
    inline (section 4).
  - Rows are written in the same runtime transaction as the change, so on Citus they land on the same shard (no 2PC).
    Platform rows (`PLATFORM_TENANT_ID`) are written by system method 8.
  - **The relay under Citus.** Every process that owns the domain runs the relay, but only **one instance is
    active** per domain set: leadership is a Redis lock (the `libs/redis/src/lock/with-lock.decorator.ts`
    mechanism, TTL renewed every poll). A session advisory lock is forbidden behind PgBouncer, and an xact lock would
    hold a transaction open across the Kafka publish.
    - Each poll, on the system pool, selects `WHERE published_at IS NULL ORDER BY created_at LIMIT n` as a
      multi-shard read **without row locks** (multi-shard `FOR UPDATE SKIP LOCKED` is unsupported on Citus), in its
      own short transaction.
    - It publishes outside any transaction, then marks each row published with a router
      `UPDATE … SET published_at = now() WHERE tenant_id = $1 AND id = $2`.
  - Delivery becomes at-least-once (a leadership handover can resend a batch); consumers already dedupe by envelope
    id. This replaces the publish-after-commit relays.
  - The ledger's `billing.ledger-posting.v1` topic rides this relay (ledger design section 3); its consumer is
    idempotent by deterministic ledger entry id. Citus CDC is a possible later alternative.
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

## 13. Testing strategy (amended 2026-11-09; see the sharding design sections 6 and 7.5 and the ledger design section 6.4)

- **RLS integration specs.** They run on Testcontainers Citus (`citusdata/citus:14.2.0`, single node) through
  `startTestPostgres({ localExecution: false, initSql })` from `@platform/testing/postgres`, with the three roles
  created by the same init SQL as compose. `citus.enable_local_execution=off` is required: with local execution on,
  a single node hides context-propagation bugs (`set_config` looks correct there). For every policy they cover:
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
- **Sharding.** One smoke spec in `libs/database` runs coordinator + one worker (`workers: 1`): distribution, a router
  query, a multi-shard query, the context across nodes and WITH CHECK. Distribution migration specs assert the
  `pg_dist_partition` kind of every table.
- **Ledger (immudb).** Int specs run `codenotary/immudb:1.11.2` in Testcontainers (readiness `GET /readyz` on 9497;
  the image is distroless): provisioning, privileges (UPDATE denied), every mapped error string, the MVCC race and
  proofs, including a byte-flip negative. A shared contract spec runs against both the in-memory fake and the
  adapter; verification primitives are checked against golden vectors generated by the Go SDK.

## 14. Risks (amended 2026-11-09; see the sharding design section 10 and the ledger design sections 2.1, 6.3 and A1)

| Risk                                                                           | Mitigation                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| RLS returns empty results instead of errors                                    | Fail-loud `app.user_id()`; both-path integration specs; row-count checks                                                                                                                                                                                                                                                 |
| Overhead per database call                                                     | Handler-level transactions; one `SET LOCAL` round trip; k6 gate at B3                                                                                                                                                                                                                                                    |
| Citus policy restrictions                                                      | No subqueries in policies, and row-local policies only: no function a policy calls reads a table (B3 ruling, 2026-11-17). A forgotten `(select …)` fails loudly at `CREATE POLICY`                                                                                                                                       |
| Single-node local execution hides propagation bugs                             | RLS specs with `citus.enable_local_execution=off`; the `workers: 1` smoke spec                                                                                                                                                                                                                                           |
| `SET LOCAL` is built from strings                                              | Strict UUID regex, nil UUID refused, unit spec with hostile input; values come from verified JWT claims only                                                                                                                                                                                                             |
| amd64-only Citus images (`citusdata/citus:14.2*`)                              | Apple Silicon runs them under emulation (`platform: linux/amd64`); int-spec timeouts have headroom                                                                                                                                                                                                                       |
| Fan-out queries when a repository forgets the tenant predicate                 | Explicit `tenant_id = $param` rule; reference-table writes (users, memberships) are 2PC but rare                                                                                                                                                                                                                         |
| immudb cannot erase, and its Node SDK is abandoned (`immudb-node` 1.1.1, 2021) | No PII in ledger rows; a generated gRPC client plus verification ported from the Go SDK with golden vectors                                                                                                                                                                                                              |
| immudb operations                                                              | Distroless image: readiness via `GET /readyz`, no exec healthcheck; error strings pinned to the image tag and covered by int specs; production `--signingKey` with a pinned public key (key management); backups by replication or volume snapshots; an immudb outage delays postings but never fails a payment (outbox) |
| gRPC principal metadata is unsigned                                            | Trusted only inside the mesh (mTLS); documented. Signed principal headers are a possible later hardening                                                                                                                                                                                                                 |
| B is large                                                                     | Four checkpoints, each with a signed commit and all gates green                                                                                                                                                                                                                                                          |
| drizzle-kit can't model `FORCE RLS`, `GRANT` or `BYPASSRLS`                    | Hand-written SQL in the platform set and the domain baselines; the CI drift check still passes because snapshots don't change                                                                                                                                                                                            |
| Local data reset                                                               | One `docker compose down -v` after B1; called out in the README and the PR description                                                                                                                                                                                                                                   |

## 15. Out of scope

- Plan-based quotas.
- Per-tenant schemas or databases.
- SSO/SAML.
- Tenant deletion and data export.
- Cross-tenant staff search: staff only switch in.
- RLS for Cassandra: isolation there is by key design.

## 16. Amendments (2026-11-09)

Source designs, reconciled with each other on 2026-11-09:

- [Sharding design: Citus 14.2 + PgBouncer 1.26](2026-11-09-sharding-citus-pgbouncer-design.md) (cited as "SH §n").
- [Stripe idempotency, immudb ledger and reconciliation](2026-11-09-stripe-ledger-immudb-design.md) (cited as
  "LG §n").

Program decisions behind them (user, 2026-11-09): B2, B3, B4, C, G and E run fast in parallel lanes (git worktrees
off `feat/domains-tenancy`, merged `--no-ff`), one GPG-signed commit per plan task, no attribution lines; plans
auto-run behind a review workflow, with no human gate; schema changes stack as numbered migrations per domain set
and a final task squashes each domain into a fresh `0000_init`. This supersedes the "one signed commit per phase"
wording of section 1's Commits row, which is left as written.

Changes, by section:

1. **§2 Roadmap.** Status refreshed (A1, H, D, F, B1 done; inventory FU-11). Phases S and L added with their slots.
2. **§4 Data ownership.** Citus 14.2 everywhere (plain Postgres an unsupported fallback); four table kinds
   (reference, distributed by `tenant_id`, distributed by `user_id`, coordinator-local) with the table list; FK rules,
   including no FK across domain schemas; distribution calls in SH-5/SH-6 and inline for later tables; explicit
   `tenant_id` predicates for routing; migrations connect directly to the coordinator, and the runner sets
   `citus.multi_shard_modify_mode = 'sequential'`; the roles table gains "Through" and "Server settings" columns;
   the boot guard also checks `citus.propagate_set_commands`; stacked numbered migrations, then a final squash.
3. **§5.1 Tables.** Kind column and exact shapes from SH §2.3 plus the ledger's B2-6 additions: composite PKs,
   tenant-leading uniques, `sessions` PK `(user_id, id)`, nullable `stripe_events.user_id`, `payments.request_hash`,
   three new payment statuses, the `tenants_id_not_platform` CHECK, the outbox and the five ledger tables; B2-26
   metadata.
4. **§8.1 Mechanism.** `SET LOCAL` replaces `set_config()` (SH §7.1); role settings via `ALTER ROLE … SET`; helpers
   called directly, never as `(select …)`; cross-table helpers read reference tables only.
5. **§8.2 Policies.** (Cross-table helpers superseded 2026-11-17: see the B3 delta below.) No subqueries; `identity.shares_current_tenant` and `identity.is_member` replace the
   membership subqueries; platform-tenant rows are system-only; ledger table policies added.
6. **§8.3.** The round-trip wording follows the `SET LOCAL` mechanism.
7. **§9 System access.** Platform webhooks and the ledger consumer's principal rule; notes on methods 3-7 under
   Citus; methods 8-11 added from LG §5. The sharding design adds no system method.
8. **§12 Outbox.** Table kind and PK; the relay under Citus: one active instance (Redis lock), multi-shard poll
   without row locks, router mark-published, at-least-once; the ledger topic rides it.
9. **§13 Testing.** RLS specs on Testcontainers Citus with `citus.enable_local_execution=off`; the sharding smoke
   spec; immudb int specs, contract spec and golden vectors.
10. **§14 Risks.** Citus policy restrictions, local execution, string-built `SET LOCAL`, amd64-only images, fan-out,
    immudb erasure/SDK and operations.

**B3 delta (2026-11-17), ruling `b3-identity-policies`.** Supersedes items 4 and 5 above where they name the
cross-table helpers:

- §8.2: identity policies are row-local. `identity.users` reads `id = user_id()` and `identity.tenants` reads
  `id = tenant_id()`; the helpers `identity.shares_current_tenant`, `identity.is_member` and `identity.staff_flag` are not
  created. Citus fails any policy whose helper reads another distributed table (`XX000`), also when that table is a
  reference table.
- §9: co-member and cross-tenant reads are system methods 12-14, asserted by the caller and filtered in SQL. This is the
  same trust model as the session context, and `docs/SECURITY.md` ("Trust model") says so.
- §4 and §8.1: no policy helper names a domain table; the cross-table bullet is dropped.
- §14: the Citus policy risk row reads "row-local policies only".

Rulings recorded in the design docs (SH §11, LG "Decisions (ruled 2026-11-09)"): Citus everywhere; users, tenants and
memberships as reference tables; sessions by `user_id`; SH-5/SH-6 distribution migrations kept by the squash
(SH-12); amd64 emulation on Apple Silicon; single active relay (Redis lock), at-least-once, router mark-published;
PgBouncer `auth_query` with a SECURITY DEFINER lookup in production and a mounted userlist in compose; worker
authentication settled in SH-8; D1 verification in wave 0 and R5 in wave 2; D2 relay → Kafka
`billing.ledger-posting.v1` → billing consumer; D3 production `--signingKey` with a pinned public key in wave 2; D4
the platform sells to tenants (no Stripe Connect); D5 the B2-6/B2-26 contents above.

Contradictions resolved between the two designs (each doc carries a "Reconciled with … on 2026-11-09" note):
nullable `stripe_events.user_id`; the ledger's table kinds (three T, two L); `PLATFORM_TENANT_ID` on one shard and
system-only under RLS; the outbox relay (no `FOR UPDATE SKIP LOCKED` across shards); `SET LOCAL` instead of
`set_config` in the ledger doc; `identity.shares_current_tenant` (not `app.`); no FK to coordinator-local tables;
inline distribution for tables created after SH-5/SH-6; ledger RLS specs on `startTestPostgres`. Checked without
conflict: env names, compose service names, config namespaces, the checkout-session unique.

Follow-ups outside these three files (for the plan writers): inventory items B3-6 ("written with
`(select app.x())`"), B3-7 (`set_config`) and G-3 (`FOR UPDATE SKIP LOCKED`) describe the superseded mechanisms; this
section and the design docs win. Shared files to serialize across the S and L lanes: `docker-compose.yml`,
`scripts/docker/check-infra.sh`, `docs/DOCKER.md`, `.env.example`, `docs/CONFIGURATION.md`.

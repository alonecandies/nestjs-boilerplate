# Sharding design: Citus 14.2 + PgBouncer 1.26

Status: ruled and reconciled (2026-11-09): decisions in section 11, reconciliation with the ledger design in
section 12, folded into the program spec (its section 16). Lane: design:sharding. Every claim marked **[P-n]** was reproduced on
`citusdata/citus:14.2.0` (PostgreSQL 18.4, Citus 14.2-1) and `edoburu/pgbouncer:v1.26.1-p0` (PgBouncer 1.26.1);
the commands and outputs are in the appendix. Parent spec (binding):
`docs/superpowers/specs/2026-10-12-domains-tenancy-rls-program-design.md` (cited as "spec §n").

## Executive summary

1. **Spec §8.1 fails on Citus.** A `set_config('app.tenant_id', $1, true)` on BEGIN never reaches a worker, so the
   shard query raised `app.user_id is not set` [P-5]. Citus propagates `SET LOCAL`, never `set_config()`.
2. **Use `SET LOCAL` instead.** Run `SET LOCAL app.user_id = '<uuid>'; SET LOCAL app.tenant_id = …; SET LOCAL
app.elevated = …`, with `ALTER ROLE app_runtime SET citus.propagate_set_commands = 'local'`. Citus prepends these
   to every remote BEGIN, including a mid-transaction elevate [P-5, P-6]. Verified through PgBouncer 1.26
   (transaction mode) with the repo's postgres.js: 200/200 correct, no leak, `prepare` true and false [P-12].
3. **No subqueries in policies.** Citus rejects them on distributed and reference tables [P-3]. Write `app.x()`, not
   `(select app.x())`. A cross-table check goes through a STABLE helper, and the helper may read only **reference**
   tables: one that reads a distributed table fails inside pushed-down joins [P-7, P-8].
4. **Layout.**
   - Reference: `users`, `tenants`, `memberships`, so the global `email` and `slug` uniques still work.
   - Distributed by `tenant_id`, colocated with the platform anchor `app.tenant_colocation`: invitations,
     audit_events, payments, stripe_events, the ledger tenant tables and the outbox.
   - `sessions`: distributed by `user_id` (refresh routes by `sub` + `jti`).
   - Bookkeeping and system-only tables: coordinator-local.
   - Rules: PKs and uniques include the distribution column [P-9]; no cross-domain FKs; FKs to reference tables
     are fine [P-10].
5. **Propagation and access work.** Roles (BYPASSRLS included), schemas, functions, GRANTs, ENABLE/FORCE RLS,
   policies and enums propagate, created before or after distribution [P-4, P-9]. WITH CHECK, UPDATE and DELETE
   are filtered on the workers and on every reference placement (2PC) [P-6, P-17]. `app_system` sees all rows [P-5].
6. **Migrations** stay in drizzle's one-transaction-per-set model, under three conditions [P-10, P-14]:
   - the runner sets `citus.multi_shard_modify_mode = 'sequential'` on its direct connection;
   - each table is distributed before FKs to reference tables are added (or converted later, reference tables
     first);
   - migrations, drizzle-kit and CLIs connect directly to the coordinator.
7. **PgBouncer rejects the repo's `statement_timeout` startup parameter** (08P01) [P-12]. Move both timeouts to
   `ALTER ROLE … SET` and add `DATABASE_POOLER=pgbouncer`.
8. **Single node needs no setup** [P-11], and Testcontainers works with the Citus image [P-13]. But local execution
   makes `set_config` look correct on one node [P-11b], so RLS int specs must set
   `citus.enable_local_execution=off`. All `citusdata/citus:14.2*` tags are amd64-only (emulated on Apple Silicon).
9. **Schema-based sharding** shards by domain, not by tenant [P-15]. Not now.
10. **Order.**
    - Before B2: the Citus image in compose, Testcontainers and CI; the platform helpers; the Citus-ready table
      conventions.
    - With B2: the table shapes in section 2.3.
    - With B3: the distribution migrations, `SET LOCAL` RLS context, PgBouncer, policy specs and the worker profile.

## 1. Empirical findings (Citus 14.2 + RLS)

| #   | Question                                                                     | Result                                                                                                                                                                                                                                                                                                      |
| --- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a   | `set_config('app.tenant_id', x, true)` in BEGIN…COMMIT, query on a worker    | **Not visible.** The remote BEGIN carries no setting, and `app.user_id()` raised on the worker. The same happens with `propagate_set_commands = 'local'` (a2). [P-5]                                                                                                                                        |
| b   | `SET LOCAL app.tenant_id = '…'` with `citus.propagate_set_commands = local`  | **Visible.** Remote command: `BEGIN …;SET LOCAL app.user_id = '…';SET LOCAL app.tenant_id = '…';SET LOCAL app.elevated = 'off';SELECT assign_distributed_transaction_id(…)`. Multi-shard 3/3, router T1 3, router T2 0. [P-5]                                                                               |
| b'  | Set by role default (`ALTER ROLE app_runtime SET …`), and changed mid-tx     | Works. `SET LOCAL app.elevated = 'on'` after a remote query changed the count from 3 to 5 in the same transaction. [P-6]                                                                                                                                                                                    |
| c   | Do CREATE POLICY, ENABLE/FORCE RLS, functions, schemas and GRANTs propagate? | Yes, before and after distribution. Each shard (`p3_102019` …) carries `rls=true force=true pol=p3_a acl=…app_runtime=r…`. Policies with a SubLink are rejected. [P-3, P-4]                                                                                                                                 |
| d   | NOSUPERUSER NOBYPASSRLS non-owner role                                       | CREATE ROLE propagates. Router and multi-shard reads are filtered. INSERT into another tenant fails `new row violates row-level security policy for table "payments_102034"`. UPDATE/DELETE of other rows touch 0. No context raises. [P-6]                                                                 |
| e   | BYPASSRLS role (system pool)                                                 | Sees all 9 rows across worker shards with no context. [P-5 setup]                                                                                                                                                                                                                                           |
| f   | Reference tables with RLS                                                    | Policies propagate to the placements. A helper reading a reference table works inside worker shard queries. A helper reading a distributed table fails there. [P-7, P-8]. Runtime INSERT, with WITH CHECK on `elevated()`, and UPDATE pass the check on every placement (worker and local) under 2PC [P-17] |
| 1   | Single node (Testcontainers/dev)                                             | `create_distributed_table` alone registers `localhost`, group 0, `shouldhaveshards = t`. With local execution on, `set_config` works (5 rows); with it off, `set_config` returns 0 and `SET LOCAL` returns 5. [P-11]                                                                                        |
| PgB | postgres.js → PgBouncer 1.26 (transaction) → Citus                           | Startup `statement_timeout` is rejected. `application_name` and `TimeZone` are accepted. `SET LOCAL` context: 200/200 correct with `prepare` true and false. [P-12]                                                                                                                                         |

Other facts used below: multi-shard `SELECT … FOR UPDATE SKIP LOCKED` → `could not run distributed query with FOR
UPDATE/SHARE commands`, but the router form works [P-9]. `pg_try_advisory_xact_lock` works [P-9]. A GRANT naming a
reference table and a distributed table in one statement fails in parallel mode [P-4b]. A UNIQUE without the
distribution column is rejected [P-9]. `colocate_with => 'default'` silently joined an unrelated group [P-14]:
always name the colocation explicitly.

## 2. Table distribution

### 2.1 Rules (Citus-ready schema conventions, binding from B2 on)

1. **Kinds.** Each table is exactly one of:
   - **reference**: global, small and read-mostly, replicated to every node;
   - **tenant-distributed**: `tenant_id uuid NOT NULL`, colocated with `app.tenant_colocation`;
   - **user-distributed**: `user_id`, own colocation group;
   - **coordinator-local**: bookkeeping only.
     The kind is recorded in a comment on the schema file table definition (`// citus: reference` …), and the
     distribution migration (section 4) is the single source of truth.
2. **Keys.** On a distributed table, the PK and every UNIQUE (constraint or unique index) start with the
   distribution column. Use composite PKs `(tenant_id, id)`. `id` stays `uuid DEFAULT uuidv7()`.
3. **FKs.**
   - Distributed → reference: allowed, including `ON DELETE CASCADE` [P-14].
   - Distributed → distributed: only between colocated tables, and the FK must include the distribution column
     (`(tenant_id, parent_id) REFERENCES parent (tenant_id, id)`).
   - Reference → distributed: never.
   - Distributed → coordinator-local, and local → distributed: never [P-4b, P-15]. A column that points at a
     coordinator-local row (for example `ledger_discrepancies.run_id`) is a plain column.
   - No FK crosses a domain schema (billing → identity), so that each domain's migration set stays self-contained.
     `tenant_id` and `user_id` in billing are plain columns.
4. **Policies.**
   - No subqueries anywhere in a policy expression. Call `app.user_id()`, `app.tenant_id()` and `app.elevated()`
     directly.
   - A cross-table check goes through a STABLE SQL helper in `app` that reads **reference tables only**.
5. **Queries.** Every tenant-scoped repository query also carries an explicit `tenant_id = $param` predicate, taken
   from the principal. RLS does not prune shards: the policy predicate is evaluated on the workers, and a query
   without the predicate fans out to all shards (`WHERE true` in [P-5]). RLS stays the guarantee; the predicate is
   for routing.
6. **No `SELECT … FOR UPDATE` without a distribution-column equality** [P-9]. No `CREATE INDEX CONCURRENTLY` in
   migrations (drizzle already forbids it).
7. **Cross-shard work** (crons, outbox relay, reconciliation) runs on the system pool as multi-shard statements
   without row locks, or loops per tenant.
8. **Platform tenant.** `PLATFORM_TENANT_ID` (the nil UUID `00000000-0000-0000-0000-000000000000`) is the
   `tenant_id` of platform-level billing rows (platform Stripe events, their outbox rows, platform ledger accounts,
   entry refs and discrepancies). It is never issued as a tenant id (B2-1 adds a CHECK on `identity.tenants.id`)
   and never accepted as a runtime principal's tenant (the SH-7 context builder throws on it). All its rows hash to
   one shard: acceptable, because platform events (payouts, unattributed fees and adjustments) are a small fraction
   of tenant traffic. RLS needs no extra branch: every runtime policy requires `tenant_id = app.tenant_id()`, which
   can never be the nil UUID, so only `app_system` (BYPASSRLS, the named system methods) reads or writes those rows.
   Billing has no FK to `identity.tenants`, so no tenant row is needed for it.

### 2.2 Users: reference vs distributed by id vs local

| Option                 | users policy (spec §8.2 "shares a membership")                                                                   | Joins (members list, payments by user)                                                                                  | Global `email` unique                     | Write cost                                                                                             |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Reference (chosen)** | Works if `memberships` is also a reference table: a helper reads it locally on every node [P-8]                  | Pushed down with any distributed table [P-8]                                                                            | Yes                                       | Every insert or update is written to all nodes (2PC). Register, profile edits and staff grant are rare |
| Distributed by `id`    | The helper must read memberships: a nested distributed query is forbidden [P-7]                                  | memberships (by tenant) JOIN users (by id) is not colocated: repartition joins (off by default), and no policy pushdown | Unique on `email` impossible (needs `id`) | 1 shard                                                                                                |
| Coordinator-local      | A policy helper can't run on workers. FK from distributed tables is impossible (local ← distributed not allowed) | Joins with distributed tables are unsupported                                                                           | Yes                                       | 1 node                                                                                                 |

**Recommendation: `users`, `tenants` and `memberships` are reference tables.** Scale note: reference rows live on
every node. That is fine for millions of users with a handful of workers. If identity outgrows it, the escape hatch
is a tenant-distributed `memberships` plus a per-tenant member-profile projection (G). Spec §8.2's `users` read rule
then becomes `id = user_id() or elevated()` within a tenant join.

### 2.3 Every table

Kinds: R = reference, T = distributed by `tenant_id` colocated with `app.tenant_colocation`, U = distributed by
`user_id` (own group), L = coordinator-local.

| Table                                                                                         | Kind | PK                            | Uniques                                                                            | FKs                                                                                | Notes                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------- | ---- | ----------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app.tenant_colocation`                                                                       | T    | `(tenant_id)`                 | –                                                                                  | –                                                                                  | Empty anchor, platform set. Never queried                                                                                                                                                                                                                   |
| `<schema>.__drizzle_migrations`                                                               | L    | `id serial`                   | –                                                                                  | –                                                                                  | Created by drizzle outside the migration transaction. Untouched                                                                                                                                                                                             |
| `identity.users`                                                                              | R    | `(id)`                        | `users_email_unique (email)`                                                       | –                                                                                  | B2-5: drops `roles`, adds `is_platform_staff`. The trigram GIN index is fine on reference tables                                                                                                                                                            |
| `identity.tenants`                                                                            | R    | `(id)`                        | `tenants_slug_unique (slug)`                                                       | –                                                                                  | `id uuid DEFAULT uuidv7()`; CHECK `tenants_id_not_platform` (`id` is never the nil UUID, rule 2.1.8)                                                                                                                                                        |
| `identity.memberships`                                                                        | R    | `(tenant_id, user_id)`        | –                                                                                  | `tenant_id → tenants.id ON DELETE CASCADE`, `user_id → users.id ON DELETE CASCADE` | Index `(user_id, last_active_at DESC)`. `last_active_at` updates are replicated writes (one per login or switch)                                                                                                                                            |
| `identity.invitations`                                                                        | T    | `(tenant_id, id)`             | `invitations_token_hash_uq (tenant_id, token_hash)`                                | `tenant_id → tenants.id ON DELETE CASCADE`, `invited_by → users.id`                | Plain index `(token_hash)`. `findByTokenHash` is a multi-shard system read (one index probe per shard)                                                                                                                                                      |
| `identity.audit_events`                                                                       | T    | `(tenant_id, id)`             | –                                                                                  | `tenant_id → tenants.id ON DELETE CASCADE`                                         | `actor_id` has no FK (append-only history outlives users). Index `(tenant_id, created_at DESC)`                                                                                                                                                             |
| `identity.sessions`                                                                           | U    | `(user_id, id)`               | –                                                                                  | `user_id → users.id ON DELETE CASCADE`, `tenant_id → tenants.id ON DELETE CASCADE` | `tenant_id NOT NULL`. Refresh: `WHERE user_id = sub AND id = jti` is a router query. `deleteExpired` is multi-shard on the system pool. Index `(expires_at)`. `replaced_by_id` is a plain uuid                                                              |
| `billing.payments`                                                                            | T    | `(tenant_id, id)`             | `(tenant_id, stripe_checkout_session_id)`, `(tenant_id, user_id, idempotency_key)` | none (no cross-domain FK)                                                          | Index `(tenant_id, user_id, id)` replaces `payments_user_id_id_idx`. Adds `request_hash text` (ledger S-2). Status enum gains `refunded`, `partially_refunded`, `disputed` (ledger S-6). The webhook resolves the tenant from signed metadata, then routes  |
| `billing.stripe_events`                                                                       | T    | `(tenant_id, id)`             | –                                                                                  | none                                                                               | `user_id` **nullable** (platform-level events such as `payout.paid` carry no user; their rows use `PLATFORM_TENANT_ID`, rule 2.1.8, written by a system method). Dedup is per tenant: one Stripe event id always maps to one tenant. Index `(processed_at)` |
| `billing.ledger_accounts` (ledger design section 5)                                           | T    | `(tenant_id, code, currency)` | –                                                                                  | none                                                                               | `immudb_account_id uuid`. Platform accounts use `PLATFORM_TENANT_ID`. Created by L-10, distributed inline (section 4.2)                                                                                                                                     |
| `billing.ledger_entry_refs`                                                                   | T    | `(tenant_id, entry_id)`       | –                                                                                  | none (`payment_id` is a plain column)                                              | Append-only receipt of each immudb posting (`immudb_tx_id bigint`). Created by L-10, distributed inline                                                                                                                                                     |
| `billing.ledger_discrepancies`                                                                | T    | `(tenant_id, id)`             | –                                                                                  | none (`run_id`, `resolves_id` are plain columns: rule 2.1.3)                       | Append-only (no UPDATE/DELETE grant). Created by L-10, distributed inline                                                                                                                                                                                   |
| `billing.ledger_reconciliation_runs`, `billing.ledger_trusted_state` (system only, no tenant) | L    | `(id)`; `(database)`          | –                                                                                  | none                                                                               | Coordinator-local, touched only by the system pool. A join with a distributed table works (Citus pulls one side [P-17]), so this is a performance question, not a ban. No distribution call                                                                 |
| `<schema>.outbox` (G-1)                                                                       | T    | `(tenant_id, id)`             | –                                                                                  | none                                                                               | Written in the same transaction as the business row: the same shard, no 2PC. Created by G-1 after SH-5/SH-6, so G-1 distributes it inline (section 4.2). The relay is in section 7.4                                                                        |

**Exact B2 SQL shapes** (what drizzle must generate; the names follow the repo's explicit-name convention):

```sql
-- identity (B2-1, B2-2, B2-3, B2-4, B2-5)
CREATE TABLE "identity"."tenants" ("id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL, "slug" text NOT NULL,
  "name" text NOT NULL, "personal" boolean DEFAULT false NOT NULL,
  "created_at" timestamp (3) with time zone DEFAULT now() NOT NULL, CONSTRAINT "tenants_slug_unique" UNIQUE("slug"));
CREATE TABLE "identity"."memberships" ("tenant_id" uuid NOT NULL, "user_id" uuid NOT NULL,
  "roles" "identity"."tenant_role"[] NOT NULL, "last_active_at" timestamp (3) with time zone,
  "created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "memberships_tenant_id_user_id_pk" PRIMARY KEY("tenant_id","user_id"));
CREATE TABLE "identity"."invitations" ("tenant_id" uuid NOT NULL, "id" uuid DEFAULT uuidv7() NOT NULL,
  "email" text NOT NULL, "roles" "identity"."tenant_role"[] NOT NULL, "token_hash" text NOT NULL,
  "invited_by" uuid NOT NULL, "expires_at" timestamp (3) with time zone NOT NULL,
  "accepted_at" timestamp (3) with time zone, "created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "invitations_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"));
CREATE UNIQUE INDEX "invitations_tenant_id_token_hash_uq" ON "identity"."invitations" ("tenant_id","token_hash");
CREATE INDEX "invitations_token_hash_idx" ON "identity"."invitations" ("token_hash");
CREATE TABLE "identity"."audit_events" ("tenant_id" uuid NOT NULL, "id" uuid DEFAULT uuidv7() NOT NULL,
  "actor_id" uuid, "type" text NOT NULL, "data" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "audit_events_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"));
-- sessions: PK becomes (user_id, id); adds tenant_id
ALTER TABLE "identity"."sessions" ADD COLUMN "tenant_id" uuid NOT NULL;
ALTER TABLE "identity"."sessions" DROP CONSTRAINT "sessions_pkey";
ALTER TABLE "identity"."sessions" ADD CONSTRAINT "sessions_user_id_id_pk" PRIMARY KEY("user_id","id");
-- identity.tenants also gets: CONSTRAINT "tenants_id_not_platform" CHECK ("id" <> '00000000-0000-0000-0000-000000000000')
-- billing (B2-6; ledger design section 8.1 additions included)
ALTER TABLE "billing"."payments" ADD COLUMN "tenant_id" uuid NOT NULL, ADD COLUMN "request_hash" text;
-- PK (tenant_id, id); uniques (tenant_id, stripe_checkout_session_id) and (tenant_id, user_id, idempotency_key);
-- index (tenant_id, user_id, id)
ALTER TYPE "billing"."payment_status" ADD VALUE 'refunded';
ALTER TYPE "billing"."payment_status" ADD VALUE 'partially_refunded';
ALTER TYPE "billing"."payment_status" ADD VALUE 'disputed';
ALTER TABLE "billing"."stripe_events" ADD COLUMN "tenant_id" uuid NOT NULL, ADD COLUMN "user_id" uuid;
-- PK (tenant_id, id); user_id stays nullable (platform-level events)
```

Two notes on these shapes:

- Fresh baselines (spec §4) let B2 rewrite the `0000_init` files instead of stacking `ALTER`s. The program decision
  says stacked migrations during the program, then a squash at the end. Either way the end state is the shape above.
- In Drizzle: `primaryKey({ columns: [t.tenantId, t.id] })`, `uniqueIndex(...).on(t.tenantId, ...)`.
  `uuid().primaryKey()` alone is no longer valid on T and U tables.

## 3. Schema-based sharding

Evaluated with `citus.enable_schema_based_sharding = on` [P-15]:

- Each new schema becomes a "distributed schema", and its tables become single-shard tables in one colocation
  group per schema. All of them land on one node. FKs inside the schema and to reference tables work. An FK to a
  hash-distributed table is rejected. A join across two distributed schemas needs repartition joins.

Assessment:

- **It shards by domain, not by tenant.** `billing` stays on one node however many tenants exist, so it does not
  address tenant scale.
- **It conflicts with reference tables shared across schemas.** Identity's reference tables can't live in a
  distributed schema.
- **What it does fit:** the microservices topology. Each service's schema can sit on its own worker
  (`citus_move_shard_placement`) while still sharing one cluster, which is a database-per-service story without
  separate clusters.

Recommendation: **not now.** Use row-based distribution (section 2) for tenant scale. Revisit schema-based
sharding only for future low-volume domains (for example `files` metadata, if it moves to Postgres), where per-node
isolation matters more than tenant fan-out. It can be combined later, because the GUC only affects schemas created
while it is on.

## 4. Migrations on Citus

1. **Runner (`libs/database/src/migrator/run-migrations.ts:194-229`).**
   - After connecting, and only when `select 1 from pg_extension where extname = 'citus'` returns a row, run
     `SET citus.multi_shard_modify_mode TO 'sequential'` on the dedicated `max: 1` connection.
   - It is a session `SET`, which is safe because this connection is direct and private.
   - Reason: drizzle runs all pending files of a set in one transaction (`node_modules/drizzle-orm/pg-core/dialect.js:60-71`),
     and Citus refuses DDL on a table with a reference-FK after any parallel shard operation in that transaction
     [P-4, P-10].
   - The session advisory lock (`pg_try_advisory_lock`, `run-migrations.ts:97`) stays. It is correct only on a
     direct coordinator connection: `DATABASE_MIGRATION_URL` must never point at PgBouncer. The runner can assert
     this: PgBouncer answers `SHOW pool_mode`-style admin commands only on its admin db, so instead check that
     `select current_setting('citus.propagate_set_commands', true)` works and that the server is the coordinator
     (`select citus_is_coordinator()`).
2. **Distribution migrations.** Per domain, one custom migration (`drizzle-kit generate --custom --name
distribute`) holding only `SELECT app.make_reference('identity.users');` …
   `SELECT app.distribute_by_tenant('identity.audit_events');`, in this order:
   1. reference tables, parents before children;
   2. tenant-distributed tables;
   3. user-distributed tables.

   Converting existing local tables that already have FKs and rows works in one transaction in that order [P-14].
   New tables created after distribution follow the order CREATE TABLE → distribute → indexes → FKs → RLS and
   policies [P-10]. drizzle-kit emits FKs at the end of a file, so insert the `app.distribute_*` call right after
   each `CREATE TABLE` by hand. The repo already hand-edits generated SQL (`CREATE SCHEMA IF NOT EXISTS`), and the CI
   drift check compares snapshots, not SQL (conventions §2.15).

   Every table created **after** SH-5/SH-6 carries its own inline call; SH-5/SH-6 never see it. This binds G-1
   (`<schema>.outbox`, `app.distribute_by_tenant`) and L-10 (`billing.ledger_accounts`, `ledger_entry_refs`,
   `ledger_discrepancies`: `app.distribute_by_tenant`; `ledger_reconciliation_runs` and `ledger_trusted_state`: no
   call, they stay coordinator-local). Migration numbers are the next free `NNNN` in the domain's set at merge time;
   billing migrations stay serialized on one lane (B2-6 → SH-6 → B3-5/B3-6 → G-1 → L-10).

3. **Platform helpers** (platform set, Citus-optional: a no-op on plain Postgres) [P-16]:

   ```sql
   CREATE FUNCTION app.citus_enabled() RETURNS boolean LANGUAGE sql STABLE
     AS $$ SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'citus') $$;
   CREATE TABLE app.tenant_colocation (tenant_id uuid PRIMARY KEY);
   CREATE FUNCTION app.distribute_by_tenant(t regclass) RETURNS void LANGUAGE plpgsql AS $$ … $$;  -- anchor first, then colocate_with => 'app.tenant_colocation'
   CREATE FUNCTION app.distribute_by_user(t regclass) RETURNS void …;   -- 'user_id', colocate_with the first user table, else 'none'
   CREATE FUNCTION app.make_reference(t regclass) RETURNS void …;
   ```

   `create_distributed_table` is not idempotent ("table is already distributed" [P-14]). The helpers check
   `pg_dist_partition` first, so a re-run or squash is safe.

4. **DDL propagation and limits.** Citus propagates:
   - `ALTER TABLE` (add column, constraint), `CREATE INDEX`, policies, GRANTs;
   - `CREATE TYPE` and `ALTER TYPE … ADD VALUE` [P-9];
   - `CREATE FUNCTION` and `CREATE SCHEMA` [P-4].

   Not usable:
   - `CREATE INDEX CONCURRENTLY` inside a transaction (already impossible with drizzle);
   - multi-table `GRANT` mixing reference and distributed tables without sequential mode (covered by item 1).

5. **Role settings are migration-free.** `ALTER ROLE app_runtime SET citus.propagate_set_commands = 'local'`,
   `statement_timeout` and `idle_in_transaction_session_timeout` live in the shared init SQL (B3-2) and in
   `docs/SECURITY.md`. They are not in migrations, because migrations change schema only (spec §4).
6. **Final squash** (program decision): the squashed `0000_init` per domain keeps the hand-written distribution
   calls and RLS SQL in the same order as item 2.
7. **drizzle-kit.**
   - `db:generate` diffs snapshots and never sees shards.
   - `drizzle-kit studio` and `pull` introspect, but Citus hides shards from `pg_class` and `information_schema` by
     default (`citus.override_table_visibility`): 1 visible table, 33 with the override off [P-11].
   - All of them connect direct, never through PgBouncer.

## 5. PgBouncer 1.26 (transaction pooling)

**Which connections go where:**

| Connection                                  | Role          | Through                | URL                      |
| ------------------------------------------- | ------------- | ---------------------- | ------------------------ |
| Request pool (Drizzle, `DATABASE_POOL_MAX`) | `app_runtime` | PgBouncer              | `DATABASE_URL`           |
| System pool (max 5, spec §9)                | `app_system`  | PgBouncer              | `DATABASE_SYSTEM_URL`    |
| Migrator, drizzle-kit, `staff:grant`, CLIs  | `app_owner`   | **direct** coordinator | `DATABASE_MIGRATION_URL` |
| Health/readiness `select 1`                 | runtime pool  | PgBouncer              | –                        |

**postgres.js settings (`libs/database/src/drizzle/postgres-options.ts:32-49`):**

- `prepare` stays `true`. PgBouncer 1.26 with `max_prepared_statements = 200` handled 200 concurrent transactions
  [P-12]. `preferPreparedStatements` keeps working. `DATABASE_PREPARE=false` remains the escape hatch, for example
  for RDS Proxy.
- New config key `DATABASE_POOLER` (`zEnum(['none', 'pgbouncer'], 'none')`, database namespace). When it is
  `pgbouncer`, `buildPostgresOptions` drops `statement_timeout` and `idle_in_transaction_session_timeout` from
  `connection`, because PgBouncer rejects them [P-12]. The server applies the same values through `ALTER ROLE …
SET`. `application_name` and `TimeZone` are accepted [P-12].
- The RLS context is the multi-statement `SET LOCAL` string (section 7.1), sent with `tx.unsafe(sql).simple()`. It
  was verified with default options, with `prepare: true` and with `.simple()` [P-12b].

**Forbidden behind PgBouncer** (a state that outlives one transaction would leak to the next client):

- session `SET` / `set_config(…, false)`;
- `pg_advisory_lock`. Use `pg_advisory_xact_lock`: the identity last-admin lock already does
  (`domains/identity/src/infrastructure/persistence/drizzle-users.repository.ts:123`);
- `LISTEN` / `NOTIFY` listeners (unused today: `libs/database/src/drizzle/drizzle.types.ts:11` only mentions them);
- temp tables, `WITH HOLD` cursors, `PREPARE` by name, `DISCARD`.

The B3 boundary check can ban `pg_advisory_lock(` and `set_config(` with `false` outside `libs/database/src/migrator`.

**Pool sizing:**

- PgBouncer pools:
  - `default_pool_size` = the coordinator's capacity for `app_runtime` (start at 20);
  - `[users] app_system = pool_size=5 max_user_connections=5`;
  - `max_client_conn` ≥ Σ replicas × (`DATABASE_POOL_MAX` + 5).
- Coordinator `max_connections` ≥ Σ PgBouncer pools + migrator + admin + headroom.
- Citus fans out per coordinator backend:
  - it caches 1 connection per worker (`citus.max_cached_conns_per_worker = 1`);
  - a multi-shard query may open up to `citus.max_adaptive_executor_pool_size = 16` per worker [P-12c].
  - Set `citus.max_shared_pool_size` on the coordinator to about worker `max_connections` − 20, so that bursts queue
    instead of failing.
  - With a single node there are no worker connections (local execution).

**Auth:**

- `auth_type = scram-sha-256`.
- Production: `auth_user = pgbouncer_auth` + `auth_query = SELECT usename, passwd FROM pgbouncer.get_auth($1)`. This is
  a SECURITY DEFINER function, so no secret file is needed.
- Compose: an `auth_file` userlist generated from env (the edoburu entrypoint can write one user from
  `DATABASE_URL`; we mount our own `pgbouncer.ini` because we need two users and per-user pool sizes).
- Server-side: coordinator `pg_hba` SCRAM for PgBouncer's address.

**Worker authentication.** Citus opens coordinator → worker connections as the current user (the remote
commands ran as `app_runtime@prog-probe-worker` in [P-5]). Roles propagate [P-4], but each worker must still
authenticate those connections. The probes used trust. A deployment picks one of these:

- `pg_hba` on the workers for the coordinator's address;
- a `.pgpass` on the coordinator per role (Citus reads libpq's password file);
- certificates through `citus.node_conninfo` (for example `sslmode=verify-full`).

Before SH-8, check the Citus docs ("Citus security", "node_conninfo", "pg_dist_authinfo") to pick one. Recommended
direction: TLS through `citus.node_conninfo` plus SCRAM, with `pg_dist_authinfo` holding per-role passwords if
`.pgpass` is impractical. Single-node deployments need none of this.

**Health:** compose healthcheck `psql -h 127.0.0.1 -p 6432 -U app_runtime -d app -c 'select 1'` (verify the client
exists in the image; fallback `nc -z 127.0.0.1 6432`). App readiness keeps its `select 1` through the pool.

**Compose service (sketch):**

```yaml
pgbouncer:
  image: edoburu/pgbouncer:v1.26.1-p0
  entrypoint: ['/usr/bin/pgbouncer', '/etc/pgbouncer/pgbouncer.ini']
  volumes: ['./docker/pgbouncer:/etc/pgbouncer:ro'] # pgbouncer.ini + userlist.txt (dev passwords)
  depends_on: { postgres: { condition: service_healthy } }
  ports: ['127.0.0.1:${PGBOUNCER_HOST_PORT:-6432}:6432']
# docker/pgbouncer/pgbouncer.ini: [databases] app = host=postgres port=5432 dbname=app
#   pool_mode=transaction, max_prepared_statements=200, default_pool_size=20, max_client_conn=500,
#   ignore_startup_parameters=extra_float_digits, auth_type=scram-sha-256, [users] app_system = pool_size=5
```

**Env:**

- `x-env-postgres.DATABASE_URL` → `postgres://app_runtime:…@pgbouncer:6432/app`, plus `DATABASE_POOLER: pgbouncer`.
- `DATABASE_SYSTEM_URL` → `…app_system…@pgbouncer:6432/app`.
- `DATABASE_MIGRATION_URL` → `…app_owner…@postgres:5432/app`.
- Hosts that run apps outside compose use `127.0.0.1:${PGBOUNCER_HOST_PORT}`.

## 6. Dev and test topology

- **Compose.**
  - The `postgres` service keeps its name, port and volume and swaps its image to `citusdata/citus:14.2.0`
    (`platform: linux/amd64`, which silences the Apple Silicon warning).
  - Add `-c shared_preload_libraries=citus,pg_stat_statements` (Citus must come first), `-c citus.shard_count=8` and
    `-c citus.max_shared_pool_size=…`.
  - The image creates the extension in `POSTGRES_DB` through its own init script. Our `01-extensions.sql` keeps
    running, and its `uuidv7()` probe passes on PG 18.4.
  - Volume note: PG 18.4 with the same data layout. A fresh `down -v` is needed anyway (spec §4).
- **Workers profile `citus`** (optional):
  - `postgres-worker-1` and `postgres-worker-2` (same image, trust between nodes on the `backend` network);
  - a one-shot `citus-init` job running `citus_set_coordinator_host('postgres')`, `citus_add_node(…)` for each
    worker, and `citus_rebalance_start()` after migrations.
  - Single-node remains the default: `create_distributed_table` needs no setup there [P-11].
  - `scripts/docker/check-infra.sh` asserts `citus_version()` and, under the profile, `citus_check_cluster_node_health()`.
- **PgBouncer** is an infra service (no profile) once B3-3 lands. Before that, apps keep connecting direct.
- **Testcontainers (`@platform/testing`).** A new subpath `@platform/testing/postgres` (test-only by the `TEST_ONLY`
  rule; adds `testcontainers` and `@testcontainers/postgresql` to its `dependencies`):

  ```ts
  export interface TestPostgresOptions {
    /** 0 = single node (default); 1 = coordinator + one worker on a private network (sharding smoke only). */
    workers?: 0 | 1;
    /** false forces remote execution even on one node, so GUC-propagation bugs surface (RLS specs). */
    localExecution?: boolean;
    /** Init SQL run as superuser before the app connects (B3's shared roles script). */
    initSql?: readonly string[];
  }
  export interface TestPostgres {
    readonly url: string; // superuser / owner URL
    urlFor(role: string, password: string): string;
    stop(): Promise<void>;
  }
  export function startTestPostgres(options?: TestPostgresOptions): Promise<TestPostgres>;
  export const TEST_POSTGRES_IMAGE = 'citusdata/citus:14.2.0';
  ```

  Recipe (probed [P-13]):
  - `new PostgreSqlContainer(TEST_POSTGRES_IMAGE).withDatabase('app').withUsername('app').withPassword('app')`;
  - `.withCommand(['postgres', '-c', 'citus.shard_count=4', '-c', \`citus.enable_local_execution=${on|off}\`])`;
  - honour `INTEGRATION_DATABASE_URL` as today.

  Readiness: connect over TCP only after the container's wait strategy. A socket probe raced the init server and
  ran before `CREATE EXTENSION citus` [P-14 note].

- **Int specs:**
  - the three existing inline helpers switch to `startTestPostgres()`;
  - policy specs (B3-6) use `localExecution: false`;
  - one sharding smoke spec in `libs/database` uses `workers: 1`. It covers distribution, a router query, a
    multi-shard query and a context across nodes.
- **e2e specs** are unchanged: they use fake postgres. The compose topology check (E-4) exercises PgBouncer and
  Citus for real.

## 7. Interaction with B3 (spec §8, §9) and replacement text

### 7.1 Replace spec §8.1 "Context" bullet with

> - **Context.** On `BEGIN`, the Drizzle transactional adapter sets three transaction-local settings in **one
>   simple-protocol round trip**, from the CLS principal: `SET LOCAL app.user_id = '<uuid>'; SET LOCAL
app.tenant_id = '<uuid or empty>'; SET LOCAL app.elevated = 'on|off'`.
>   - Values are never bound parameters (`SET` takes none). The adapter builds the string only from values that pass
>     a strict UUID regex; anything else throws before SQL is sent.
>   - `set_config()` is not used: Citus propagates `SET LOCAL` to the worker connections of the transaction (the
>     role default `citus.propagate_set_commands = 'local'` on `app_runtime` and `app_system`), but never
>     `set_config()`.
>   - Transaction-local values cannot leak across pooled connections, and they work behind PgBouncer in
>     transaction mode.
>   - `elevate(permission)` issues `SET LOCAL app.elevated = 'on'` mid-transaction; Citus propagates it to
>     connections that are already open.

Replace the helper bullet's last line with:

> - Policies call each helper directly (`app.tenant_id()`, never `(select app.tenant_id())`). Citus rejects subqueries
>   in policies. The helpers are `STABLE`, and `user_id()`/`tenant_id()` read `nullif(current_setting(…, true), '')`.

Add:

> - **Cross-table policy checks** go through `STABLE` helpers that read reference tables only (for example
>   `identity.shares_current_tenant(user_id)` over `identity.memberships`; a helper that names a domain table lives
>   in that domain's schema and migration set, not in `app`). A helper that reads a distributed table fails inside
>   pushed-down queries.

### 7.2 Spec §8.2 changes

- **`identity.users` read:** `id = app.user_id() or identity.shares_current_tenant(id)`, where

  ```sql
  CREATE FUNCTION identity.shares_current_tenant(u uuid) RETURNS boolean LANGUAGE sql STABLE
    AS $$ SELECT EXISTS (SELECT 1 FROM identity.memberships m
                         WHERE m.tenant_id = app.tenant_id() AND m.user_id = u) $$;
  ```

  This helper names a domain table, so it belongs to the identity set (`identity.shares_current_tenant`), not the
  platform set. `libs/` names no domain.

- **`identity.tenants` read:** `id = app.tenant_id() or identity.is_member(id)`, using the same pattern.
- **All rows:** `(select app.x())` → `app.x()`.

### 7.3 Spec §4 changes

Roles table, add a "Server settings" column:

- `app_runtime`: `citus.propagate_set_commands = 'local'`, `statement_timeout = 15s`,
  `idle_in_transaction_session_timeout = 60s`;
- `app_system`: same;
- `app_owner`: none (the migrator sets sequential mode itself).

Boot guard additions: when `app.citus_enabled()`, refuse in production (and warn elsewhere) unless
`current_setting('citus.propagate_set_commands') = 'local'` for the runtime connection. Without it, every
remote shard query raises "app.user_id is not set": it fails closed, but loudly in every request.

### 7.4 Spec §9 notes

- **System pool:** through PgBouncer is fine, because system methods use no session state.
- **`staff:grant`:** direct, as `app_owner`.
- **Item 6 (outbox relay claim):**
  - Multi-shard `FOR UPDATE SKIP LOCKED` is unsupported [P-9].
  - The relay runs a single active instance per domain set. **Ruled 2026-11-09: leadership is a Redis lock**
    (the `libs/redis/src/lock/with-lock.decorator.ts` mechanism, TTL renewed every poll), not
    `pg_try_advisory_xact_lock`: session advisory locks are forbidden behind PgBouncer (section 5), and an xact lock
    would hold a Postgres transaction open across the Kafka publish, which spec §8.3 forbids.
  - Each poll selects `WHERE published_at IS NULL ORDER BY created_at LIMIT n` multi-shard without row locks (its
    own short transaction), publishes outside any transaction, then marks rows published by router
    `UPDATE … WHERE tenant_id = $1 AND id = $2`. That is at-least-once (a leadership handover can resend a batch);
    consumers dedupe on the envelope id, and the ledger consumer is idempotent by deterministic entry id.
  - Platform rows (`tenant_id = PLATFORM_TENANT_ID`) flow through the same relay.
  - Alternative for later: Citus CDC (`citus.enable_change_data_capture`) with logical decoding.
- **Item 4 (`sessions.deleteExpired`) and item 5:** multi-shard `DELETE … WHERE expires_at < now()` on the system
  pool works (no locks requested).

### 7.5 Spec §13 and §14 changes

- §13: "RLS specs run on Testcontainers Citus (single node, `citus.enable_local_execution=off`) …; one sharding smoke
  spec runs coordinator + worker."
- §14 risk row: "Citus policy restrictions (no subqueries; helpers read reference tables only)" and "amd64-only Citus
  image".

## 8. Split: before B2, with B2, after B2

**BEFORE B2 executes (mustPrecedeB2):**

1. Swap the Postgres image to `citusdata/citus:14.2.0` in `docker-compose.yml` (keep the service name), in
   Testcontainers (three inline `IMAGE` constants → `startTestPostgres`) and in CI `integration`, with
   `shared_preload_libraries=citus,pg_stat_statements`. All existing specs must stay green on single-node Citus.
2. Add the platform helpers `app.citus_enabled()`, `app.tenant_colocation`, `app.distribute_by_tenant()`,
   `app.distribute_by_user()` and `app.make_reference()` (platform set `0001`), plus the runner's sequential-mode
   `SET`.
3. Adopt the Citus-ready conventions (section 2.1) as a plan-writer rule, so that the B2 plans use the section 2.3
   shapes (composite PKs, tenant-leading uniques, no cross-domain FKs, no subqueries in later policies).

**WITH B2:**

- the table shapes of section 2.3 (B2-1 … B2-6), including the ledger design's B2-6 additions (`request_hash`,
  nullable `stripe_events.user_id`, the three payment statuses) and the `tenants_id_not_platform` CHECK;
- `sessions` PK `(user_id, id)`;
- repositories add explicit `tenant_id` predicates (rule 2.1.5);
- the refresh lookup by `(user_id, id)`;
- invitations by `(tenant_id, token_hash)`.

**AFTER B2 / with B3:**

- distribution migrations per domain;
- the replacement of spec §8.1 (`SET LOCAL` adapter) inside B3-7;
- `ALTER ROLE` settings inside B3-2;
- policies without subqueries inside B3-6;
- policy specs with local execution off;
- the PgBouncer service and `DATABASE_POOLER` with B3-3;
- the boot-guard addition with the B3 boot guard;
- the worker compose profile, the sharding smoke spec and docs.

## 9. Proposed tasks

| Id    | Title                                                                      | Files (main)                                                                                                                                                                           | Tests                                                                                                                                                    | Size | Wave                 |
| ----- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | -------------------- |
| SH-1  | `@platform/testing/postgres`: `startTestPostgres` on the Citus image       | `libs/testing/src/postgres/*.ts`, `libs/testing/package.json` (exports `./postgres`, deps), the 3 int specs' inline helpers, `docs/TESTING.md`                                         | `libs/testing` int spec: starts, `citus_version()`, `localExecution` flag honoured; existing int specs green                                             | M    | pre-B2               |
| SH-2  | Compose and CI on Citus single node                                        | `docker-compose.yml` (postgres image, preload, `platform`), `scripts/docker/check-infra.sh`, `.github/workflows/ci.yml`, `docs/DOCKER.md`                                              | `validate-compose.sh`, `check-infra.sh` asserts the citus extension                                                                                      | S    | pre-B2               |
| SH-3  | Platform Citus helpers + runner sequential mode                            | `libs/database/src/platform/migrations/0001_citus_helpers.sql` + journal, `run-migrations.ts`, `libs/database/README.md`                                                               | int: helpers no-op on plain PG and distribute on Citus; runner applies a FK-to-reference migration in one tx                                             | M    | pre-B2               |
| SH-4  | Conventions doc: Citus-ready schema rules                                  | `docs/DEVELOPMENT.md` ("Database migrations"), `docs/superpowers/plans/program-work/conventions.md` addendum                                                                           | –                                                                                                                                                        | S    | pre-B2               |
| SH-5  | Identity distribution migration                                            | `domains/identity/.../migrations/NNNN_distribute.sql` (custom), `identity.migrations.spec.ts`                                                                                          | int: `pg_dist_partition` kinds per table, colocation with the anchor                                                                                     | S    | after B2-1…B2-5      |
| SH-6  | Billing distribution migration                                             | `domains/billing/.../migrations/NNNN_distribute.sql`                                                                                                                                   | same                                                                                                                                                     | S    | after B2-6           |
| SH-7  | RLS context via `SET LOCAL` (replaces spec §8.1 in B3-7) + spec text edits | `libs/database/src/drizzle/drizzle-transactional.adapter.ts`, `rls-context.ts` (`buildRlsContextSql`), spec §8.1/8.2/4/13/14                                                           | unit: UUID validation, string shape, `PLATFORM_TENANT_ID` refused as a runtime tenant; int (`localExecution: false`): context visible on shards, no leak | M    | B3 (merge into B3-7) |
| SH-8  | Role server settings in the shared init SQL                                | B3-2's init SQL, `docs/SECURITY.md` (also: worker authentication for the three roles, section 5)                                                                                       | int: `pg_roles.rolconfig` contains the settings                                                                                                          | S    | B3 (merge into B3-2) |
| SH-9  | PgBouncer service + `DATABASE_POOLER`                                      | `docker/pgbouncer/{pgbouncer.ini,userlist.txt}`, `docker-compose.yml`, `libs/config/src/namespaces/database.config.ts`, `postgres-options.ts`, `.env.example`, `docs/CONFIGURATION.md` | unit: options omit the two GUCs; e2e compose: an app through PgBouncer; `check-infra.sh` checks the pgbouncer pool                                       | M    | B3 (with B3-3)       |
| SH-10 | Boot guard: `propagate_set_commands = local` on Citus                      | `libs/database/src/...boot-guard...`                                                                                                                                                   | unit + int                                                                                                                                               | S    | B3 (with boot guard) |
| SH-11 | Worker compose profile + sharding smoke spec                               | `docker-compose.yml` (`citus` profile, `citus-init`), `libs/database/test/sharding.int-spec.ts` (`workers: 1`), `docs/DOCKER.md`                                                       | smoke: router, multi-shard, cross-node context, WITH CHECK                                                                                               | M    | after B3             |
| SH-12 | Squash keeps distribution SQL                                              | the final-squash task's checklist                                                                                                                                                      | the squash spec asserts `pg_dist_partition` unchanged                                                                                                    | S    | final                |

## 10. Risks

1. **Policy shape restrictions** (no subqueries; helpers read only reference tables). Mitigated by rule 2.1.4 and the
   policy specs. A forgotten `(select …)` fails at `CREATE POLICY`, loudly.
2. **Single-node local execution hides propagation bugs** [P-11]. Mitigation: `localExecution: false` in the RLS specs,
   plus the `workers: 1` smoke spec.
3. **The amd64-only image** makes Testcontainers and dev slower on Apple Silicon (emulated). The probes passed;
   int-spec timeouts (120 s/180 s) have headroom.
4. **SQL built from strings for `SET LOCAL`.** Mitigation: a strict UUID regex plus a unit spec with hostile input. The
   values come from verified JWT claims only.
5. **Reference-table write amplification** (memberships `last_active_at`, users). Fine at boilerplate scale. Revisit
   with the escape hatch in section 2.2.
6. **Fan-out queries** when a repository forgets the tenant predicate: correct but slow. Mitigation: rule 2.1.5 and
   an optional `citus.log_multi_shard_queries`-style check in the k6 run (B3-1).
7. **STABLE plpgsql `app.user_id()`** is not inlined. Per-row evaluation cost goes into the B3 k6 gate (spec §8.3:
   10 % p95).
8. **Cross-node FKs and `ON DELETE CASCADE`** from reference to distributed tables run as distributed transactions.
   Tenant deletion is a rare multi-shard operation and should run on the system pool.
9. **Shared probe network:** `prog-probe-net` belonged to another lane, so this lane used `prog-probe-citus-net`.
   Plans that probe should name their own network.

## 11. Decisions (ruled 2026-11-09)

The user chose auto-run plans; the controller ruled on every open question. Each line: ruling, then rationale.

1. **Citus everywhere** (compose, Testcontainers, CI); plain Postgres is an unsupported fallback (the platform helpers
   stay no-ops there, but nothing tests it). Rationale: one engine in every environment, so propagation bugs surface
   in dev and CI, not production.
2. **`identity.users`, `identity.tenants`, `identity.memberships` are reference tables.** Rationale: keeps the global
   `email`/`slug` uniques and lets policy helpers read memberships on every node (section 2.2, [P-7, P-8]).
3. **`identity.sessions` is distributed by `user_id`**, PK `(user_id, id)`. Rationale: refresh routes by `sub` +
   `jti` without knowing the tenant first.
4. **Distribution calls live in separate custom migrations per domain right after the B2 table tasks (SH-5, SH-6),
   and the final squash keeps them (SH-12).** Tables created later distribute inline (section 4.2). Rationale: B2
   tasks stay plain drizzle output; one reviewable migration per domain owns the kinds.
5. **Apple Silicon runs the amd64 image under emulation** (`platform: linux/amd64`). Rationale: every
   `citusdata/citus:14.2*` tag is amd64-only and the probes passed within the existing int-spec timeouts.
6. **Outbox relay: a single active relay per domain set, at-least-once, router mark-published**, leader by Redis
   lock (section 7.4). Rationale: multi-shard `FOR UPDATE SKIP LOCKED` is unsupported [P-9]; consumers already dedupe.
7. **PgBouncer auth: `auth_query` through a SECURITY DEFINER lookup (`pgbouncer.get_auth`) in production; a mounted
   `userlist.txt` in compose.** Rationale: no secret file in production; two users with per-user pool sizes in dev.
8. **Worker authentication is settled inside SH-8** after reading the Citus security docs (`node_conninfo`,
   `pg_dist_authinfo`), starting from the recommended TLS + SCRAM direction (section 5). Rationale: single-node
   compose, Testcontainers and CI need none of it, so it blocks nothing before B3.

## 12. Reconciled with the ledger design on 2026-11-09

Reconciled with `docs/superpowers/specs/2026-11-09-stripe-ledger-immudb-design.md`. Changes made here:

- `billing.stripe_events.user_id` is **nullable** (was NOT NULL in section 2.3 and the B2 SQL); platform-level events
  use `PLATFORM_TENANT_ID` (new rule 2.1.8, which also answers why one hot nil-tenant shard is acceptable and how RLS
  treats those rows).
- Section 2.3 now lists the exact ledger tables: three tenant-distributed (`ledger_accounts` PK
  `(tenant_id, code, currency)`, `ledger_entry_refs` PK `(tenant_id, entry_id)`, `ledger_discrepancies` PK
  `(tenant_id, id)`) and two coordinator-local (`ledger_reconciliation_runs`, `ledger_trusted_state`); the B2 SQL
  carries the ledger's B2-6 additions (`request_hash`, three payment statuses) and the nil-UUID CHECK on tenants.
- Rule 2.1.3: no FK from a distributed table to a coordinator-local one (`ledger_discrepancies.run_id` is a plain
  column).
- Section 4.2: tables created after SH-5/SH-6 (G-1 outbox, L-10 ledger tables) distribute inline; billing migration
  order on its lane.
- Sections 7.1 and 7.2: the cross-table helper is `identity.shares_current_tenant` (identity set), never
  `app.shares_current_tenant`; the two sections had disagreed.
- Section 7.4: the relay leader is a Redis lock; the ledger topic `billing.ledger-posting.v1` rides the same relay.
- Checked, no conflict: the ledger's "tenant-leading unique" note concerns `billing.payments`'s checkout-session
  unique `(tenant_id, stripe_checkout_session_id)`, which section 2.3 already has; `identity.sessions` (kind U, PK
  `(user_id, id)`) is not touched by the ledger. Env names (`DATABASE_POOLER`, `PGBOUNCER_HOST_PORT` vs `IMMUDB_*`,
  `LEDGER_*`) and compose services (`postgres`, `pgbouncer`, `postgres-worker-*`, `citus-init` vs `immudb`) do not
  collide. Shared files to serialize: `docker-compose.yml`, `scripts/docker/check-infra.sh`, `docs/DOCKER.md`,
  `.env.example`, `docs/CONFIGURATION.md` (SH-2, SH-9 vs L-2, L-6).

## Appendix: probe evidence

Scripts: `/private/tmp/claude-501/-Users-maddie-Desktop-Work-BE-nestjs-boilerplate/759fc645-eefd-45d1-87c2-0c35f3bf30a0/scratchpad/citus/`
(`NN-*.sql` with `NN.out`, `node/*.mjs` with `*.out`). Every container and network was removed afterwards
(`docker ps -a --filter name=prog-probe-` was empty).

**Setup.**

- Containers: `docker run -d --name prog-probe-{coord,worker} --network prog-probe-citus-net -e
POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=app citusdata/citus:14.2.0`.
- Versions: `citus_version()` = `Citus 14.2.0 on x86_64-pc-linux-gnu`, `version()` = `PostgreSQL 18.4`.
- Image architectures: Docker Hub tags `14.2.0`, `14.2.0-alpine`, `14.2.0-pg17`, `14.2.0-pg16` all report
  `["amd64"]`.
- Cluster: `citus_set_coordinator_host('prog-probe-coord', 5432)`, `citus_add_node('prog-probe-worker', 5432)`,
  `citus.shard_count = 4`. Coordinator group 0 `shouldhaveshards f`; worker group 1 `t`.

**P-3** (policy shapes):

- Local table with a `(SELECT app.tenant_id())` policy, then `create_distributed_table` → `ERROR: cannot create
policy DETAIL: Subqueries are not supported in policies on distributed tables`.
- A policy on a distributed table: `USING (tenant_id = app.tenant_id())` → `CREATE POLICY`.
- `USING (tenant_id = (SELECT app.tenant_id()))` → `ERROR: unexpected non-SELECT command in SubLink`. An EXISTS
  subquery fails the same way.
- Reference table `(SELECT app.user_id())` → the same error. A helper call works.

**P-4** (propagation, read on the worker through `run_command_on_workers`):

- roles `app_owner:false,app_runtime:false,app_system:true` (rolbypassrls);
- functions `app.tenant_id(),app.user_id(),app.elevated(),app.member_of(uuid)`;
- schema ACLs `identity=app_owner=UC/app_owner app_runtime=U/app_owner …`;
- shards `p3_102019 rls=true force=true pol=p3_a acl=app_owner=arwdDxtm/app_owner app_runtime=r/app_owner` (RLS set
  up before distribution);
- `p2_102015 rls=true force=false pol=p2_a` (set up after).

**P-4b:** `GRANT … ON identity.memberships, billing.payments, identity.users, identity.tenants TO …` → `ERROR: cannot
execute DDL on table "users" because there was a parallel DDL access to distributed table "payments" in the same
transaction`. It succeeds inside `BEGIN; SET LOCAL citus.multi_shard_modify_mode TO 'sequential'; … COMMIT`. Adding a
FK from a local table to a distributed table fails: `cannot create foreign key constraint since foreign keys from
reference tables and local tables to distributed tables are not supported`.

**P-5** (deciding probe, `psql -U app_runtime`, `citus.log_remote_commands = on`):

```
(a) BEGIN; SELECT set_config('app.user_id',UA,true), set_config('app.tenant_id',T1,true), …; SELECT count(*) FROM billing.payments;
NOTICE: issuing BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED;SELECT assign_distributed_transaction_id(0, 63, …)
NOTICE: issuing SELECT count(*) AS a_multi_shard FROM billing.payments_102032 payments WHERE true
ERROR:  app.user_id is not set   CONTEXT: PL/pgSQL function app.user_id() line 3 at RAISE  while executing command on prog-probe-worker:5432
(b) BEGIN; SET LOCAL citus.propagate_set_commands='local'; SET LOCAL app.user_id=…; SET LOCAL app.tenant_id=…; SET LOCAL app.elevated='off';
NOTICE: issuing BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED;SET LOCAL app.user_id = '…a1';SET LOCAL app.tenant_id = '1111…';SET LOCAL app.elevated = 'off';SELECT assign_distributed_transaction_id(0, 64, …)
 b_multi_shard 3 | b_router_t1 3 | b_router_t2 0
(a2) SET LOCAL citus.propagate_set_commands='local' + set_config(...) → ERROR: app.user_id is not set (on the worker)
setup, as app_system (BYPASSRLS, no context): e_system_sees_all_payments_no_context 9, e_system_sees_all_memberships 3
```

**P-6** (`ALTER ROLE app_runtime SET citus.propagate_set_commands = 'local'`; new session shows `local`):

- `d_multi_not_elevated 3`; after `SET LOCAL app.elevated = 'on'` in the same transaction,
  `d_multi_elevated_after_mid_tx_set 5`; `d_router_elevated_t2 0`.
- INSERT T1 → `INSERT 0 1`. INSERT T2 → `ERROR: new row violates row-level security policy for table
"payments_102034" CONTEXT: while executing command on prog-probe-worker:5432`.
- UPDATE own → 4; another member's → 0; another tenant's → 0. DELETE another tenant's → 0; own → 1.
- Reference `users` read: 2 rows (a, b; c is hidden). No context at all → `ERROR: app.user_id is not set`.

**P-7:** `memberships` (distributed) JOIN `users` (reference, whose policy helper reads distributed memberships) →
`ERROR: cannot execute a distributed query from a query on a shard … CONTEXT: SQL function "shares_current_tenant"
… while executing command on prog-probe-worker:5432`. Router and multi-shard variants fail alike.

**P-8:** the helper rewritten over a reference copy `identity.memberships_ref`:

- distributed payments JOIN reference users → `a@x | 3`;
- users alone → `a@x, b@x`;
- reference JOIN reference → `a@x owner, b@x member`.

**P-9** (as app_owner and app_system):

- Multi-shard `SELECT … FOR UPDATE SKIP LOCKED` → `ERROR: could not run distributed query with FOR UPDATE/SHARE
commands`. The router form returns 2 rows.
- `pg_try_advisory_xact_lock(727002)` → `t`.
- UNIQUE(ext) without `tenant_id` → `cannot create constraint … Distributed relations cannot have UNIQUE, EXCLUDE, or
PRIMARY KEY constraints that do not include the partition column`.
- FK to `payments(id)` → `there is no unique constraint matching given keys`.
- `CREATE TYPE billing.st`, then a distributed table, then `ALTER TYPE … ADD VALUE 'c'`: the worker enum is `a,b,c`.

**P-10** (drizzle-style single transaction):

- Default mode, distribute parent and child, then add the FK to reference users → `ERROR: cannot modify table
"m_child" because there was a parallel operation on a distributed table in the transaction … HINT: SET LOCAL
citus.multi_shard_modify_mode TO 'sequential'`.
- With sequential first: CREATE TABLEs → distribute → composite FK → reference FK → index → ENABLE RLS → policy →
  GRANT → `COMMIT`.
- Local tables with FKs to reference users, then distributing the parent → `cannot create foreign key constraint
since foreign keys from reference tables and local tables to distributed tables are not supported` (local tables
  that reference a reference table become Citus local tables).

**P-11** (single node, fresh container, no setup):

- `pg_dist_node` is empty before; after `create_distributed_table`: `localhost | 0 | t`, 32 shards (the default).
- `information_schema.tables` in schema billing: 1, and 33 with `citus.override_table_visibility = off`.
- **P-11b** (as app_runtime):
  - local execution on, `set_config` → `s_a_multi 5` (correct: local execution shares the backend);
  - local execution off, `set_config` → `s_off_a_multi 0` (remote connections to itself, setting lost);
  - local execution off, `SET LOCAL` + propagate → `s_off_b_multi 5`.

**P-12** (postgres.js 3.4.9 from the repo, Node 24.4.0 → PgBouncer 1.26.1 `pool_mode=transaction`,
`default_pool_size=2`, `max_prepared_statements=200` → coordinator):

```
A startup params as in buildPostgresOptions ERR 08P01 unsupported startup parameter: statement_timeout
B only application_name + TimeZone OK { st: '0', tz: 'UTC', an: 'probe' }
C citus GUC as startup param ERR 08P01 unsupported startup parameter: citus.multi_shard_modify_mode
set_config via pgbouncer ERR app.user_id is not set
D prepare:true  { ok: 200, bad: 0, errs: [], leak: 'no leak (app.user_id is not set)' }
E prepare:false { ok: 200, bad: 0, errs: [], leak: 'no leak (app.user_id is not set)' }
```

D and E ran 200 concurrent `sql.begin` transactions with alternating tenants (T1 expects 3, T2 expects 4) and a
router count plus a multi-shard count each.

- **P-12b:** `tx.unsafe(multiSetLocal)`, `tx.unsafe(multi, [], { prepare: true })` and `tx.unsafe(multi).simple()`
  through PgBouncer all returned `{ c: 3 }`.
- **P-12c:** after the run, the worker had 2 `app_runtime` `citus_internal` backends: one cached per coordinator
  backend, and PgBouncer's pool was 2. Settings: `citus.max_shared_pool_size 100`,
  `citus.max_adaptive_executor_pool_size 16`, `citus.max_cached_conns_per_worker 1`.

**P-13:** Testcontainers 12.2.0 from the repo (`TESTCONTAINERS_RYUK_DISABLED=true`, container named
`prog-probe-tc`): `new PostgreSqlContainer('citusdata/citus:14.2.0')…withCommand(['postgres','-c','citus.shard_count=4','-c','citus.enable_local_execution=off'])`
→ `started in 14294 ms`. Results: `sc: '4', le: 'off'`; `create_distributed_table` → `localhost shouldhaveshards true`,
4 shards.

**P-14** (B2-shaped local tables with FKs and rows, converted later; single node, `citus.shard_count=4`):

- One tx, sequential: `create_reference_table` for users, tenants and memberships; `create_distributed_table`
  for sessions (`user_id`, `'none'`), audit_events (`'default'`) and invitations; then billing payments
  (`'default'`) and stripe_events. All succeed, data is copied, and FKs are recreated on the shards
  (`sessions_user_fk_102014` …).
- **Caveat:** `colocate_with => 'default'` put audit_events, invitations and the billing tables in the SAME group
  (2) as sessions, which was created with `'none'`. A second `create_distributed_table` → `ERROR: table "payments"
is already distributed`.
- Note: a readiness loop on the unix socket connected to the init-time server before `CREATE EXTENSION citus` ran
  (`function create_reference_table(unknown) does not exist`). The rerun over `-h 127.0.0.1` passed.

**P-15** (schema-based sharding):

- `citus_schemas`: `ledgerx 5`, `notesx 6`. Tables are `partmethod n` with 1 shard each, all on `prog-probe-worker`.
- FK to a reference table works. FK to `billing.payments` → `A distributed table can only have foreign keys if it is
referencing another colocated hash distributed table or a reference table`.
- Cross-schema join → `the query contains a join that requires repartitioning`.

**P-17** (re-probe, coordinator + worker, `memberships` as a reference table with RLS, `app_runtime` with
role default `propagate_set_commands = local`):

- INSERT with `elevated = off` → `ERROR: new row violates row-level security policy for table "memberships_102008"
CONTEXT: while executing command on prog-probe-worker:5432`.
- With `elevated = on`: `INSERT 0 1` twice, executed on the worker and locally (`executing the command locally`),
  then `PREPARE TRANSACTION 'citus_0_361_23_0'` and `COMMIT PREPARED`.
- `UPDATE … last_active_at` on the own row → `UPDATE 1`; on another user's row → `UPDATE 0`.
- 2 placements; the worker count is 2.
- As `app_system`: a coordinator-local `identity.local_runs` JOIN distributed `identity.dist` → `1 | 1`.

**P-16:** the platform helpers (`app.citus_enabled`, `app.distribute_by_tenant` with the anchor created on first
use, `app.make_reference`) work inside one sequential transaction. Result: `ledg.r n 1`, `ledg.sess h 3` (`'none'`),
`ledg.a h 4` (with the anchor; the anchor row was not printed because schema `app` is on role `app`'s search_path,
the B3-2 caveat).

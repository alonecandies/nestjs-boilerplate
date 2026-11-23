# @platform/database

PostgreSQL for the monorepo. It provides a tuned **postgres.js** pool, **Drizzle ORM** (a global
`DatabaseModule`), transactions that propagate through CLS (`@Transactional()`), **migration sets** applied by an
**advisory-locked** runner (at boot, or by each app's `migrate.ts` through `runMigrationsCli`), a readiness
contributor, and **uuidv7 keyset-pagination** helpers.

Domain tables live in the domain packages, each in its own Postgres schema with its own drizzle-kit config and
migration history (`domains/<x>`). This package owns the connection, the runner, the
**platform set** (schema `app`, extensions) and the rule that the platform set always runs first.

Every runtime query runs as `app_runtime` (`NOBYPASSRLS`) under forced row-level security: the adapter opens each
transaction with the principal's `SET LOCAL` context, repositories reach it through `inUnitOfWork`, `RlsElevation`
widens a policy inside it, and principal-less work goes through `SystemDatabase` on a small `app_system` pool (see
[Roles and row-level security](#roles-and-row-level-security)). Nothing in this package names a domain.

Production refuses a `DATABASE_URL` without TLS (`?sslmode=verify-full`, `require` or `verify-ca`, `ssl=true`, or
`sslrootcert=system`; as in postgres.js, the last value of a repeated parameter wins). An `ssl` option passed in
code (`DatabaseModule` `postgres.ssl`) wins at runtime, but the boot check only reads the URL: keep
`?sslmode=require` there too, or set `DATABASE_ALLOW_INSECURE=true` when a sidecar encrypts the hop.

## Public API

| Export                                                                                                                                                  | Kind                    | Purpose                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DatabaseModule.forRootAsync<S>(options: DatabaseModuleOptions<S>): DynamicModule`                                                                      | module (global)         | Pool + Drizzle handle, transactional CLS plugin, migrations on boot, health indicator. Validates `migrations` when called                                                                                                                                                                          |
| `DatabaseModuleOptions<S>`                                                                                                                              | interface               | `{ schema: S; migrations: readonly DatabaseMigrationSet[]; runMigrations?; transactional?: boolean \| DatabaseTransactionalOptions; postgres?: PostgresOptions }`                                                                                                                                  |
| `DatabaseTransactionalOptions`                                                                                                                          | interface               | `{ defaultTxOptions?: PgTransactionConfig; enableTransactionProxy?: boolean }`                                                                                                                                                                                                                     |
| `DatabaseMigrationSet`                                                                                                                                  | interface               | `{ name; folder; migrationsSchema; migrationsTable; onlineFolder? }`: one migration history with its own bookkeeping table, and optional [online steps](#online-steps)                                                                                                                             |
| `platformMigrations`                                                                                                                                    | const                   | The platform set (`src/platform/migrations`, bookkeeping `app.__drizzle_migrations`): always applied first                                                                                                                                                                                         |
| `withPlatformMigrations(sets)`                                                                                                                          | fn                      | `[platformMigrations, ...sets]`; throws on a set listed twice or two sets sharing a bookkeeping table                                                                                                                                                                                              |
| `assertMigrationSets(sets)`                                                                                                                             | fn                      | Throws unless the platform set is first, no set is listed twice, each set has its own bookkeeping table and no two sets with online steps share a schema (`runMigrations` calls it)                                                                                                                |
| `DRIZZLE`, `DATABASE_MODULE_OPTIONS`                                                                                                                    | symbols                 | Injection tokens                                                                                                                                                                                                                                                                                   |
| `InjectDrizzle()`                                                                                                                                       | decorator               | `@InjectDrizzle() private readonly db: DrizzleDB<typeof schema>`                                                                                                                                                                                                                                   |
| `DrizzleDB<S>`, `DrizzleTransaction<S>`, `DrizzleExecutor<S>`, `DrizzleSchema`                                                                          | types                   | Handle (`PostgresJsDatabase<S> & { $client: Sql }`), tx handle, db-or-tx, schema record                                                                                                                                                                                                            |
| `DrizzleTransactionalAdapter<S>`, `DrizzleTransactionHost<S>`                                                                                           | types                   | Adapter and `TransactionHost` typing for your schema                                                                                                                                                                                                                                               |
| `Transactional`, `TransactionHost`, `InjectTransaction`, `InjectTransactionHost`, `Propagation`                                                         | re-exports              | From `@nestjs-cls/transactional` (same package instance)                                                                                                                                                                                                                                           |
| `DrizzlePostgresTransactionalAdapter`, `normalizeTxConfig(config)`                                                                                      | class, fn               | Drizzle adapter that drops empty tx configs (see Gotchas)                                                                                                                                                                                                                                          |
| `runMigrations(url, options): Promise<MigrationRunSummary>`                                                                                             | fn                      | Exactly `options.migrations`, in order: single-session client + `pg_try_advisory_lock` polling + drizzle `migrate()` per set, then the set's online steps on a second session                                                                                                                      |
| `RunMigrationsOptions`, `MigrationRunSummary`, `MigrationSetSummary`                                                                                    | types                   | `{ migrations, logger?, applicationName?, lockTimeoutMs?, lockPollIntervalMs?, lockWaitTimeoutMs?, lockWaitRetries?, lockWaitRetryDelayMs?, onlineLockTimeoutMs? }` → `{ sets: [{ name, folder, total, applied, online }], total, applied, online }` (`online`: `{ total, applied }` online steps) |
| `runMigrationsCli(migrations, args?)`                                                                                                                   | fn                      | Body of every app's `src/migrate.ts`: config from env, platform set + `migrations`, JSON log lines, `process.exitCode`                                                                                                                                                                             |
| `MIGRATIONS_TABLE` (`__drizzle_migrations`), `ONLINE_MIGRATIONS_TABLE` (`__online_migrations`), `MIGRATIONS_ADVISORY_LOCK_ID`                           | consts                  | The bookkeeping table name of every set, and of its online steps; the one lock key                                                                                                                                                                                                                 |
| `DatabaseHealthIndicator`                                                                                                                               | provider                | `HealthContributor` with key `postgres` (`select 1`, 2 s timeout, cancels the query)                                                                                                                                                                                                               |
| `keysetWhere(col, cursor, dir?)`, `keysetOrder(col, dir?)`, `keysetFetchLimit(limit)`, `keysetPage(rows, limit)`, `keysetPageBy(rows, limit, cursorOf)` | fns                     | Seek pagination → `CursorPage<T>` from `@platform/common`                                                                                                                                                                                                                                          |
| `encodeIdCursor(id)`, `decodeIdCursor(cursor)`, `normalizePageLimit(limit)`, `IdCursor`, `KeysetDirection`                                              | fns, types              | A bad cursor throws a 422 `INVALID_CURSOR`                                                                                                                                                                                                                                                         |
| `buildPostgresOptions(cfg, ctx, overrides?)`, `PostgresOptions`, `IDLE_IN_TRANSACTION_TIMEOUT_MS`                                                       | fn, type                | Config → postgres.js options (seconds vs ms handled)                                                                                                                                                                                                                                               |
| `createDrizzleDatabase(cfg, app, options, logger?)`                                                                                                     | fn                      | The factory behind `DRIZZLE`, usable outside Nest                                                                                                                                                                                                                                                  |
| `PoolUsage(pool, max)`, `PoolUsageSnapshot`                                                                                                             | class, interface        | Connection demand of one postgres.js pool: `track(client)` returns a counting wrapper (awaited top-level queries and `begin()` transactions; `reserve()`, `listen()` not counted), `snapshot()` → `{ pool, max, inUse, waiting }`                                                                  |
| `registerPoolUsage(usage)`                                                                                                                              | fn                      | Publishes a `PoolUsage` as the gauges below (one entry per pool name, the latest registration wins); `createDrizzleDatabase` registers `pool="runtime"`                                                                                                                                            |
| `DB_POOL_CONNECTIONS_IN_USE`, `DB_POOL_OPERATIONS_WAITING`, `DB_POOL_CONNECTIONS_MAX`                                                                   | consts                  | `db_pool_connections_in_use`, `db_pool_operations_waiting`, `db_pool_connections_max`, gauges labelled `{pool}` (see [OBSERVABILITY.md](../../docs/OBSERVABILITY.md#metrics-prometheus))                                                                                                           |
| `isTransientConnectionError(e)`, `describePostgresUrl(url)`, `DrizzleQueryLogger`                                                                       | helpers                 | Boot retries, credential-free log target, SQL debug logging                                                                                                                                                                                                                                        |
| `inUnitOfWork(txHost, work)`                                                                                                                            | fn                      | The only way a runtime repository reaches the database: `work` runs in the open transaction or a new one (`Propagation.Required`) opened with the CLS principal's context; throws `RLS_CONTEXT_STALE` when the principal is not the one `BEGIN` applied                                            |
| `assertRowsAffected(result, expected, what)`, `RowCountMismatchError`                                                                                   | fn, class               | Under RLS a hidden write affects 0 rows instead of failing: a repository that expects a change checks the count                                                                                                                                                                                    |
| `buildRlsContextSql(input)`, `rlsContextOf(principal)`, `getAppliedRlsContext()`, `RLS_UUID_PATTERN`, `RlsContextError`                                 | fns, const, class       | The `SET LOCAL` string (the one string-built SQL; values must match the strict UUID pattern), the context of a principal, and what `BEGIN` sent for the active transaction                                                                                                                         |
| `RlsElevation` (`elevate(permission)`, `justified(reason, work)`), `ELEVATION_REASONS`, `ELEVATION_DENIED`                                              | provider, consts        | Turns `app.elevated` on in the open transaction after a TypeScript permission check, or for a closed list of reasons (`*.elevated.ts` files only)                                                                                                                                                  |
| `SystemDatabase.run(method, work)`, `InjectSystemDatabase()`, `SYSTEM_DATABASE`, `SystemDatabaseError`                                                  | class, decorator, token | The only door to the `app_system` pool on `DATABASE_SYSTEM_URL`; `*.system-repository.ts` files only. Logged and counted (`db_system_calls_total`)                                                                                                                                                 |
| `defineSystemMethod(name, scope)`, `SystemMethod`, `SystemMethodScope`                                                                                  | fn, types               | One named door: `<repository>.<method>`, scope `pre-auth` (anywhere) or `system` (inside `SystemContext.run` only)                                                                                                                                                                                 |
| `purgeInTimeSlices(options)`, `DEFAULT_PURGE_SLICE_MS`, `DEFAULT_PURGE_MAX_SLICES`, `MIN_PURGE_SLICE_MS`                                                | fn, consts              | Bounded progress for a purge of a distributed table (no `LIMIT` pushdown on Citus): `min(t)` of the due rows, one DELETE up to it + a slice (15 min), at most 96 per run; a slice that hits `statement_timeout` is retried at half the span                                                        |
| `DatabaseBootGuardError`, `BootGuardFinding`                                                                                                            | class, interface        | What `DatabaseModule` throws in `DATABASE_BOOT_GUARD=enforce` when a connection or table is not as required                                                                                                                                                                                        |

## Usage

```ts
// apps/orders-service/src/database.migrations.ts — one list for AppModule and migrate.ts
export const DATABASE_MIGRATIONS: readonly DatabaseMigrationSet[] = [ordersMigrations];

// app.module.ts
import { ordersSchema } from '@domain/orders'; // the domain's tables + relations record
@Module({
  imports: [
    AppConfigModule.forRoot(),
    ObservabilityModule.forRoot({ healthContributors: [DatabaseHealthIndicator] }),
    // monolith: { ...ordersSchema, ...activitySchema } and [ordersMigrations, activityMigrations]
    DatabaseModule.forRootAsync({ schema: ordersSchema, migrations: DATABASE_MIGRATIONS }),
  ],
})
export class AppModule {}

// migrate.ts — the release job (`node dist/migrate.js`)
import 'reflect-metadata';
await runMigrationsCli(DATABASE_MIGRATIONS);

// drizzle-orders.repository.ts (infrastructure layer)
import { type DrizzleTransactionalAdapter, inUnitOfWork, keysetFetchLimit, keysetOrder, keysetPage, keysetWhere, TransactionHost } from '@platform/database';

@Injectable()
export class DrizzleOrdersRepository {
  // TransactionHost is a class → imported as a VALUE (DI by type).
  constructor(private readonly txHost: TransactionHost<DrizzleTransactionalAdapter<typeof ordersSchema>>) {}

  async list(q: { tenantId: string; limit: number; cursor?: string }) {
    // inUnitOfWork: the open transaction, or a new one that starts with the principal's SET LOCAL context.
    const rows = await inUnitOfWork(this.txHost, (tx) =>
      tx.select().from(orders)
        .where(and(eq(orders.tenantId, q.tenantId), keysetWhere(orders.id, q.cursor))) // explicit tenant: one shard
        .orderBy(keysetOrder(orders.id))          // ORDER BY id DESC
        .limit(keysetFetchLimit(q.limit)));       // limit + 1 look-ahead
    return keysetPage(rows, q.limit);             // { items, nextCursor }
  }
}

// a command handler: both writes commit or roll back together, no tx argument threading
@Transactional()
async execute(cmd: PlaceOrderCommand) { await this.orders.insert(...); await this.lineItems.insert(...); }
```

## Roles and row-level security

Three roles come from one script, `docker/postgres/init/02-roles.sql` (compose runs it once on an empty volume;
`startRlsTestPostgres()` runs it in every spec that asserts isolation; production SQL is in
[SECURITY.md](../../docs/SECURITY.md#database-roles)). Roles never come from a migration.

| Role          | URL                      | Connects to                      | Does                                                                                  |
| ------------- | ------------------------ | -------------------------------- | ------------------------------------------------------------------------------------- |
| `app_owner`   | `DATABASE_MIGRATION_URL` | the coordinator, never a pooler  | owns schemas and tables; runs migrations, drizzle-kit, `staff:grant`. No fallback URL |
| `app_runtime` | `DATABASE_URL`           | PgBouncer in compose and prod    | every request; `NOBYPASSRLS`; no privilege beyond its per-table grants                |
| `app_system`  | `DATABASE_SYSTEM_URL`    | PgBouncer, at most 5 connections | `BYPASSRLS`; only the named system methods (`SystemDatabase.run`)                     |

- **FORCE RLS everywhere.** Each domain table has `ENABLE` and `FORCE ROW LEVEL SECURITY`, so even the owner is
  filtered (it has no policy and sees no row). The boot guard refuses a domain table without both.
- **Grants are explicit and deny by default.** No default table privileges: a table is unreachable until its own
  migration grants it to `app_runtime` and, for a system method, to `app_system`. The bookkeeping tables
  (`<schema>.__drizzle_migrations`, and `<schema>.__online_migrations` of a set with online steps) carry no RLS and
  no grant; the boot guard treats both as internal.
- **Migrations change schema only; backfills run as `app_system`.** A migration runs as `app_owner`, which `FORCE` makes
  blind to every row: a data `UPDATE` there would touch nothing, silently. A backfill is a separate step on the system
  pool, in a named system method.
- **A unit of work per call.** A repository method runs `inUnitOfWork(txHost, (tx) => …)`. A standalone call opens a
  transaction whose `BEGIN` is followed by the principal's `SET LOCAL` context (about 4 round trips: `BEGIN`, the
  context, the query, `COMMIT`); inside a handler's `@Transactional()` it joins that transaction at no extra cost.
  The principal is final before a unit of work opens: `runWithPrincipal` wraps the unit of work, never the other way
  round, and ids a flow needs for its principal are generated before `BEGIN`. No principal means no `BEGIN`
  (`RLS_NO_PRINCIPAL`); a different principal inside the transaction means `RLS_CONTEXT_STALE`.
- **Row counts.** A write the policies hide affects 0 rows instead of failing: repositories whose method must change one
  row call `assertRowsAffected(result, 1, '…')`.
- **No domain names here.** `libs/` never names a domain (`scripts/libs-vocabulary.spec.ts`); each domain owns its
  distribution migration, its RLS migration and its repositories.
- **Behind PgBouncer:** no session `SET`, no `set_config(…, false)`, no `pg_advisory_lock`, no `LISTEN`, no temp tables.
  `pg_advisory_xact_lock` is fine.

Policies are row-local: only the row's own columns and `app.user_id()`, `app.tenant_id()`, `app.elevated()`, called
directly (see [SECURITY.md](../../docs/SECURITY.md#row-level-security) for why, and for elevation, the system pool and
the boot guard).

### Adding a system method

A principal-less or cross-tenant read or write belongs on the system pool.

1. Define it in the domain's `<domain>.system-methods.ts`:
   `defineSystemMethod('<repository>.<method>', 'pre-auth' | 'system')`. Use `pre-auth` only for a lookup that runs
   before any principal exists (login, register, an invitation token); everything else is `system` and runs inside
   `SystemContext.run('<domain>.<job>', …)`.
2. Implement it in a `drizzle-<x>.system-repository.ts` (the only files that may name `SystemDatabase` or
   `@InjectSystemDatabase()`), through `this.system.run(methods.<name>, (db) => …)`, behind an abstract
   `<x>.system-repository.ts` port. Put the scoping predicate in the SQL itself (`tenant_id = $caller`, the caller's own
   id): the database does not check it.
3. Grant `app_system` what the method needs, per table, in a new RLS migration of that domain (never
   `ALL`, never a table the method does not touch).
4. Update the domain's `*.system-methods.spec.ts` (the pinned list) and the table in
   [SECURITY.md](../../docs/SECURITY.md#the-system-pool); `scripts/docs-b3.spec.ts` fails until both name it.
5. Add an int spec that shows the method returns only the asserted rows (and, for `system` scope, that it refuses
   outside `SystemContext`).

### Adding a table

In the migration that creates it, in this order (one statement per `GRANT` and per policy, one table per statement):

1. `CREATE TABLE` with `tenant_id` or `user_id` leading its keys ([Citus-ready rules](../../docs/DEVELOPMENT.md#citus-ready-schema-rules));
2. the distribution call (`app.distribute_by_tenant`, `app.distribute_by_user` or `app.make_reference`), then indexes, then foreign keys;
3. `ALTER TABLE … ENABLE ROW LEVEL SECURITY` and `… FORCE ROW LEVEL SECURITY`;
4. the policies, `TO app_runtime`, row-local, one per command the runtime role needs (no policy means denied);
5. explicit grants to `app_runtime`, and to `app_system` only for a system method.

Then repositories use `inUnitOfWork`, and a both-path policy spec (`startRlsTestPostgres()`, local execution off) asserts
exact rows for the allowed and the forbidden case. Without step 3 the boot guard refuses to start.

## Migrations

| Set                                         | Postgres schema | Files                                                   | Produced by                                                      |
| ------------------------------------------- | --------------- | ------------------------------------------------------- | ---------------------------------------------------------------- |
| `platformMigrations`                        | `app`           | `libs/database/src/platform/migrations`                 | hand-written ([Platform migration set](#platform-migration-set)) |
| `<x>Migrations`, one per domain with tables | `<x>`           | `domains/<x>/src/infrastructure/persistence/migrations` | `domains/<x>/drizzle.config.ts`                                  |

- **Order.** `DatabaseModule` (with `runMigrations` / `DATABASE_RUN_MIGRATIONS`) and `runMigrationsCli` apply
  `withPlatformMigrations(migrations)`: the platform set, then the app's sets in array order, under ONE advisory lock
  (`MIGRATIONS_ADVISORY_LOCK_ID`) on one dedicated connection. Several services can share a database and boot
  together: their runs are serialised.
- **One bookkeeping table per set** (`<schema>.__drizzle_migrations`). drizzle's migrator compares file timestamps only
  with the newest row of the table it writes to, so two histories in one table would silently skip the older one's
  files. `withPlatformMigrations` rejects a shared table.
- **The runner checks it too, before it connects.** `runMigrations` refuses sets that do not start with the platform
  set, two sets sharing a bookkeeping table and a set whose folder has no `meta/_journal.json`, whoever calls it.
- **Direct coordinator only.** On Citus, `runMigrations` refuses a node that is not the coordinator
  (`citus_is_coordinator()` false on a node that is in a cluster; a fresh single node counts as the coordinator).
  Its session sends `statement_timeout = '0'` as a startup parameter, which PgBouncer refuses (`08P01`): the runner
  rethrows that as an error naming `DATABASE_MIGRATION_URL`, which must never point at the pooler.
- Each set's pending files run in one transaction (all-or-nothing per set); a set that already ran stays applied when
  a later set fails. What a transaction cannot run (`CREATE INDEX CONCURRENTLY`, `VALIDATE CONSTRAINT`) goes in the
  set's [online steps](#online-steps).
- **Bounded lock waits.** The session also sends `lock_timeout` (`DATABASE_MIGRATION_LOCK_TIMEOUT_MS`, 5 s), and a set
  that hits it is retried; see [Lock waits](#lock-waits).

### Lock waits

An `ALTER TABLE` takes `ACCESS EXCLUSIVE` on its table (and on Citus on every shard). If an open transaction holds any
lock on that table (a long report, an operator session, `pg_dump`), the `ALTER` waits, and every query that arrives
after it queues behind the `ALTER`. Without a limit, a release job can stall all traffic to the table until the
blocker ends, and each queued request fails at its own 15 s `statement_timeout`. So the runner bounds the wait:

- **`lock_timeout` on the migration session.** `DATABASE_MIGRATION_LOCK_TIMEOUT_MS` (default `5000`; `0` = no limit) is
  sent as a startup parameter, at boot (`DATABASE_RUN_MIGRATIONS`) and in the release job alike. A statement that waits
  longer fails with SQLSTATE `55P03`.
- **On Citus, the worker connections too.** The session's setting stays on the coordinator: the connections Citus opens
  to the workers start from the role's default. So, before the migration session opens, a short preliminary
  connection checks for the coordinator, makes the connecting role's default `lock_timeout` equal the setting
  (`ALTER ROLE CURRENT_USER SET lock_timeout`, only when it differs; Citus propagates it to the workers) and closes:
  a session that ran the `ALTER ROLE` would keep worker connections opened with the old value.
  `docker/postgres/init/02-roles.sql` and the production SQL in [SECURITY.md](../../docs/SECURITY.md) give `app_owner`
  the same default up front. It also bounds drizzle-kit and operator sessions as `app_owner`.
- **Retry, then fail.** drizzle has rolled the set back whole, so nothing of it is recorded. The runner retries it after
  a backoff (1 s, doubling, at most 30 s), still under the advisory lock, up to `DATABASE_MIGRATION_LOCK_RETRIES`
  times (default 5), logging a warning per retry. Then the run fails with
  `Migration set "<name>" (<folder>) failed: lock_timeout (<ms>ms) expired on all <n> attempts (SQLSTATE 55P03)`,
  and the `55P03` error as `cause`. The sets before it stay applied; the ones after it are not attempted.
- **What a `55P03` failure means.** Some transaction kept a lock on a table the set changes for the whole retry window.
  Nothing of the set was applied, so rerunning the job is safe. Find the blocker first (`pg_stat_activity`,
  `pg_locks`, `pg_blocking_pids()`), let it end or stop it, then rerun. Raise the timeout only for a change you know
  waits behind short transactions; `0` brings the unbounded wait back.
- **One lock-taking change per release.** All pending files of a set run in one transaction, so a lock the first file
  takes is held until the last file commits. Keep each release to one `ALTER` (or one group on one table) per set,
  and ship expand/contract steps in separate releases.
- **Covered by tests.** `test/database.int-spec.ts` runs the `test/fixtures/lock-wait` set against a table that
  another connection holds `ACCESS SHARE` on: it fails within seconds with `55P03`, recording nothing, and applies once
  when the blocker commits during the backoff. The int container is a single Citus node, whose shard connections go
  to itself: the [online steps](#online-steps) test shows there that they start from the role default, not from the
  session's `lock_timeout`, and that a run leaves the default at this setting. On a coordinator plus one worker, that
  a role default reaches the worker connections, and a session `lock_timeout` does not, was probed by hand
  (`docs/superpowers/plans/2026-11-23-audit-fixes.md`, verified point 6), not in a spec.

### Online steps

drizzle runs a set's pending files in one transaction, where `CREATE INDEX CONCURRENTLY` and a long
`ALTER TABLE … VALIDATE CONSTRAINT` cannot go (the first refuses a transaction block; the second would hold its lock
for the whole set). A set can therefore declare an `onlineFolder` (convention:
`join(import.meta.dirname, 'migrations', 'online')`; drizzle reads only the files its journal lists, so the subfolder
is left alone, and it ships in `dist/` like the other migration files):

- **Files.** `NNNN_<name>.sql`, numbered like drizzle-kit's, ONE statement each, hand-written. The runner reads the
  folder before it connects: a declared folder that is missing, another file, two files with one number or a file
  without a statement fail the run up front. A file goes to the server on the extended protocol, which refuses
  several statements (`42601`) instead of running them as one implicit transaction.
- **When.** Right after the set's transactional files, still under the advisory lock, each pending file runs on its
  own, outside any transaction, and is recorded in `<schema>.__online_migrations` (`name`, `applied_at`) only after it
  succeeded. The run summary counts them per set and in total (`online: { total, applied }`); the CLI's `Done:` line
  adds them when a set has any. Two sets with online steps cannot share a schema (`assertMigrationSets`).
- **A second session.** The steps run on a session of their own, opened while the migration session keeps the lock,
  with `lock_timeout` = `DATABASE_MIGRATION_ONLINE_LOCK_TIMEOUT_MS` (default `0`, wait). Not the 5 s of
  [Lock waits](#lock-waits): a lock timeout cancels a concurrent build and leaves an invalid index (verified point 6),
  and these statements take no lock that blocks reads or writes. A concurrent build still waits for every
  transaction that writes the table, and for older snapshots, so it ends only after them.
- **On Citus.** The shard connections start from the role's default, not from the session. So the runner sets the
  role default to the online value on a throwaway connection before it opens the online session, and back to
  `DATABASE_MIGRATION_LOCK_TIMEOUT_MS` on another one after that session closed, also when a step failed. A run that
  crashed in between leaves the online value; the next run's start-of-run check ([Lock waits](#lock-waits)) sets it
  back. Switching the default between the two phases is tested on the single-node int container only; on a
  multi-node cluster it is UNTESTED.
- **Failure and retry.** A failing file stops the run with
  `Migration set "<name>": online step <file> (<path>) failed; nothing was recorded for it, …` and the driver's error
  as `cause`; the transactional files stay applied, the sets after it are not attempted, and the next run retries the
  file. Write each statement to be re-runnable (`CREATE INDEX CONCURRENTLY IF NOT EXISTS …`). A failed concurrent
  build leaves an INVALID index, which `IF NOT EXISTS` would then skip, so before a file runs the runner drops
  (`DROP INDEX CONCURRENTLY`) an invalid index with the name that file's own `CREATE INDEX CONCURRENTLY` builds, on its
  table, and logs a warning. Only that one: an invalid index elsewhere may be another session's build in progress.
- **Covered by tests.** `test/database.int-spec.ts` with the `test/fixtures/gizmos` set: one file applied once and
  recorded, then 0 on the next run; a unique index over duplicate rows that fails, records nothing, leaves an invalid
  index, and is dropped and built valid by the next run; a two-statement file refused; and on the Citus database the
  index built on all four shards of the distributed table while another transaction holds a lock on one shard for
  3 s, with the sets' timeout at 500 ms, and the role default back at 500 ms afterwards. Without the role switch that
  case fails with `55P03` from a shard connection.

```bash
bun run db:generate                                    # drizzle-kit generate in every domain (commit the output)
bun run --filter @domain/<x> db:generate --name <change>
bun run db:migrate                                     # the monolith's src/migrate.ts from sources (root .env)
bun run --filter @app/<x>-service db:migrate           # an app's dist/migrate.js (after build): the release job
bun run db:studio                                      # Drizzle Studio per domain, each on its own port
```

`runMigrationsCli` logs one JSON object per line (`ConsoleLogger({ json: true })`, what log shippers ingest from
deploy jobs); `LOG_PRETTY=true` (default in development) switches to coloured text. Exit code 0 = schema current,
1 = failure (an unknown flag included).

A domain's first migration comes from `bun run --filter @domain/<x> db:generate --name init`. drizzle-kit writes
`CREATE SCHEMA "<x>";` first, but the migrator has already created that schema for `<x>.__drizzle_migrations`, so
change that line to `CREATE SCHEMA IF NOT EXISTS "<x>";` (the domain's `*.migrations.spec.ts` checks it). Every other
generated file is committed as generated. Never edit an applied migration.

Set `DATABASE_RUN_MIGRATIONS=true` (or `runMigrations: true`) to migrate at boot; it needs `DATABASE_MIGRATION_URL`
(`app_owner`), and the app then serves requests as `app_runtime`. In production, prefer each app's `dist/migrate.js` as a
one-off job.

## Environment (`database` namespace, plus `SERVICE_NAME` from `app`)

`DATABASE_URL` (`app_runtime`), `DATABASE_SYSTEM_URL` (`app_system`; unset = no system pool, refused in production by config and by the `enforce` boot
guard, `system.configured`),
`DATABASE_MIGRATION_URL` (`app_owner`, direct to the coordinator; required where migrations or CLIs run; no URL ever
falls back to `DATABASE_URL`), `DATABASE_POOL_MAX` (20), `DATABASE_SYSTEM_POOL_MAX` (5, at most 5), `DATABASE_POOLER`
(`none`; `pgbouncer` stops sending the two timeouts as startup parameters, the roles carry them),
`DATABASE_BOOT_GUARD` (`enforce` in production, `warn` elsewhere, `off` for fake databases),
`DATABASE_IDLE_TIMEOUT_SEC` (30), `DATABASE_MAX_LIFETIME_SEC` (1800), `DATABASE_CONNECT_TIMEOUT_SEC` (10),
`DATABASE_STATEMENT_TIMEOUT_MS` (15000), `DATABASE_PREPARE` (true; stays true behind PgBouncer 1.26, `false` is the
escape hatch), `DATABASE_LOG_QUERIES` (false; params are logged only outside production), `DATABASE_RUN_MIGRATIONS`
(false), `DATABASE_MIGRATION_LOCK_TIMEOUT_MS` (5000; the migration session's `lock_timeout`, 0 = no limit),
`DATABASE_MIGRATION_LOCK_RETRIES` (5; [Lock waits](#lock-waits)) and `DATABASE_MIGRATION_ONLINE_LOCK_TIMEOUT_MS` (0 =
wait; the online steps' session, [Online steps](#online-steps)). `SERVICE_NAME` becomes the session's `application_name`. Every session also gets `TimeZone=UTC`, and
`idle_in_transaction_session_timeout=60s` and `statement_timeout` (direct connections as startup parameters, pooled ones
from the role settings). The full table is in [CONFIGURATION.md](../../docs/CONFIGURATION.md#database--postgresql-18-postgresjs--drizzle).

## Tests

- Unit (`bunx vitest run --project database`) needs no database. `test/fake-sql.ts` fakes the postgres.js pool
  (`unsafe`, `begin`, `end`), so drizzle's real session code runs: module wiring, `@Transactional()` commit and
  rollback, boot retries, the platform-first rule, the per-set runner under one lock, the CLI and health are covered.
- Integration (`INTEGRATION=1 bunx vitest run --project database:int`) uses `startTestPostgres()` from
  `@platform/testing/postgres` (Citus 14.2 on PostgreSQL 18.4; the databases it creates have no `citus`
  extension, so they are plain Postgres). It covers concurrent `runMigrations` over two sets, separate bookkeeping tables (`gadgets`, a set
  with older timestamps, still applies), the CLI (`test/fixtures/migrate.ts`, an app-style entry), boot migrations,
  startup GUCs, `uuidv7()` defaults, pool usage gauges against a real pool (`test/pool-usage.int-spec.ts`), transactions, keyset paging, health and shutdown. `test/fixtures/migrations` is
  real drizzle-kit output
  (`drizzle-kit generate --dialect=postgresql --schema=./test/fixtures/widgets.schema.ts --out=./test/fixtures/migrations --casing=snake_case`);
  `test/fixtures/gadgets/migrations` is hand-written. `test/citus.int-spec.ts` covers the
  Citus helpers (placement, colocation, idempotency, kind changes, the plain-Postgres no-op) and the runner's
  Citus session settings (a set applied while sessions default to remote execution, and the parallel-mode
  failure they avoid), with the `test/fixtures/citus` set. `test/platform-rls.int-spec.ts`
  (`startRlsTestPostgres()`, migrated as `app_owner`, local execution off) covers the 0002 helpers as `app_runtime`,
  `SET LOCAL` reaching every shard where `set_config()` does not, the grants and the default privilege, and the
  missing-role stop. The RLS specs all use `startRlsTestPostgres()` (the three roles, `citus.enable_local_execution=off`,
  never `INTEGRATION_DATABASE_URL`): `test/rls-context.int-spec.ts` (the `SET LOCAL` context
  reaching every shard of a distributed fixture, `WITH CHECK` on a foreign insert, concurrent principals alternating over
  a small pool, `RLS_NO_PRINCIPAL`, each with `DATABASE_PREPARE` true and false), `test/rls-elevation.int-spec.ts`
  (`elevate` widening the same transaction's read but never to another tenant, `justified` for its callback only, the
  next transaction on the connection not elevated, a refused elevation sending nothing, a savepoint that elevated and
  rolled back leaving own rows on every shard and a later `justified` elevating again), `test/system-database.int-spec.ts`
  (the system pool reading every row where the runtime handle reads none, a `system` method refused outside
  `SystemContext`, a system write surviving a runtime rollback, the pool cap), `test/boot-guard.int-spec.ts` (each check refusing in
  `enforce` and leaving no backend behind) and `test/sharding.int-spec.ts` (coordinator plus one worker: the context
  crossing the wire, a mid-transaction `elevate`, `set_config` failing where `SET LOCAL` works, a reference-table write
  on every node). Unit specs fake the pool (`test/fake-sql.ts`), so `bunx vitest run --project database` still needs no
  Docker.

## Gotchas

- **`@Transactional()` needs no `ClsModule.forRoot`**: this module registers its plugin with
  `ClsModule.registerPlugins()`. `@platform/observability` owns `ClsModule.forRoot` (request ids), and the two compose.
  Never pass `DatabaseModule` in a plugin's `imports`, because that creates a second copy with no options.
- **Empty tx options break drizzle**: `TransactionHost` always passes the merged options object (`{}` by default),
  and drizzle renders `{}` as `set transaction ` (a 42601 syntax error on a real server). Our adapter drops empty
  configs. If you register your own plugin (`transactional: false`), use `DrizzlePostgresTransactionalAdapter`.
- `DrizzleDB` is a type alias: inject it with `@InjectDrizzle()` and import the type with `import type`.
  `TransactionHost` is a class and must be imported as a value.
- `*.schema.ts` files may import only `drizzle-orm*` and relative files, because drizzle-kit loads them with its own
  loader. Declare tables with `pgSchema('<x>').table(...)` and export the `pgSchema` object (drizzle-kit emits
  `CREATE SCHEMA` only for exports). `casing: 'snake_case'` must match in every `drizzle.config.ts` and at runtime.
  Raw SQL uses snake_case and schema-qualified names (`orders.line_items`, `ARRAY['placed']::orders.order_status[]`).
- The compose and testcontainers superuser is `app`, and the platform set creates schema `app`: a session as that role
  has `app` first on its `search_path` (`"$user", public`), so unqualified DDL lands in `app`. Qualify names in
  hand-written SQL. The three application roles (`app_owner`, `app_runtime`, `app_system`) each pin `search_path =
pg_catalog, public`, so nothing resolves through a schema that shares a role's name.
- **A data statement in a migration touches nothing.** Migrations run as `app_owner`, which `FORCE ROW LEVEL SECURITY`
  filters to zero rows. A backfill is a separate step on the system pool.
- **A runtime write the policy hides is a 0-row success.** Check the count (`assertRowsAffected`); an `INSERT` the
  `WITH CHECK` refuses does raise (`42501`).
- **Never run a spec's isolation checks as the superuser or with local execution on.** Local execution makes
  `set_config` look correct on one node, and a superuser bypasses every policy.
- Pass `date.toISOString()` for a JS `Date` inside a raw ` sql` `` template, not the `Date` itself. Operators
  (`lt(col, date)`) are fine.
- `migrate()` runs a set's pending migrations in **one transaction**, so `CREATE INDEX CONCURRENTLY` goes in the set's
  [online steps](#online-steps), never in a drizzle file.
  A migration whose journal timestamp is older than the last applied one **of the same set** is **silently
  skipped**: regenerate after merges. CI's generated-artefacts drift step runs `bun run db:generate` and fails
  when the schema files and the committed migrations disagree; it does not check timestamp order. CI runs
  `bun run db:check` (`drizzle-kit check` per domain), which fails on a forked snapshot chain; run it after every
  merge that touches a migrations folder. The runner refuses
  a journal whose `when` values do not grow (or an entry without a positive integer `when` or a boolean
  `breakpoints`) before it connects, but it cannot see a file older than a row a database already holds.
- Build prepared statements in the constructor body, never in field initialisers.
- Keyset indexes: a plain ASC btree is scanned backwards for `DESC`. Drizzle's `.desc()` emits `NULLS LAST`, which
  does not match `ORDER BY … DESC`.

## Platform migration set

`platformMigrations` (`src/platform/migrations`, bookkeeping in `app.__drizzle_migrations`) holds the SQL no domain
owns: the `app` schema and the extensions domain tables rely on (`pg_trgm` for a domain's trigram index, created
`WITH SCHEMA public` because drizzle-kit writes `gin_trgm_ops` unqualified). It is applied before every domain set,
under the same advisory lock, and cannot be left out.

`0001_citus_helpers.sql` adds the Citus distribution helpers: `app.citus_enabled()`, the empty colocation
anchor `app.tenant_colocation (tenant_id uuid PRIMARY KEY)`, `app.citus_table_kind(regclass)`,
`app.distribute_by_tenant(regclass)` (hash on `tenant_id`, colocated with the anchor),
`app.distribute_by_user(regclass)` (hash on `user_id`, one group for all user tables) and
`app.make_reference(regclass)`. Without the `citus` extension they return at once; with it they check
`pg_dist_partition` first, so a re-run is a no-op, and they raise instead of changing a table's kind. Domain
sets call them from a hand-written `distribute` migration ([DEVELOPMENT.md](../../docs/DEVELOPMENT.md#citus-ready-schema-rules)).
When the database has the `citus` extension, `runMigrations` sets `citus.enable_local_execution = on` and
`citus.multi_shard_modify_mode = 'sequential'` on its private session, so a set can create a schema or enum,
distribute tables and add their foreign keys in one transaction, also on a server whose sessions default to
remote execution. The migration URL must reach the coordinator directly, never a transaction pooler.

`0002_rls_helpers.sql` adds the RLS context helpers every policy calls (program spec 8.1, sharding design 7.1):

| Helper            | Returns   | Value                                                                            |
| ----------------- | --------- | -------------------------------------------------------------------------------- |
| `app.user_id()`   | `uuid`    | `app.user_id`; raises `42501` `app.user_id is not set` when it is unset or empty |
| `app.tenant_id()` | `uuid`    | `app.tenant_id`, or `NULL` when unset or empty                                   |
| `app.elevated()`  | `boolean` | true only when `app.elevated` is the literal `on`                                |

All three are `STABLE` and read `current_setting(…, true)`. The context is set with `SET LOCAL` on `BEGIN`, never
`set_config()` (Citus propagates only `SET LOCAL` to shard connections), and policies call the helpers directly,
never in a subquery. The file also holds the platform half of the grant model (deny by default): `USAGE` on schema
`app` and `EXECUTE` on the three helpers and `app.citus_enabled()` for `app_runtime` and `app_system`, nothing for
`PUBLIC` on any function in `app` (the 0001 distribution helpers are for migrations only), no grant on
`app.__drizzle_migrations`, and `ALTER DEFAULT PRIVILEGES FOR ROLE app_owner REVOKE EXECUTE ON FUNCTIONS FROM
PUBLIC`, so every later function is granted explicitly. Roles never come from a migration: on a server without
`app_owner`, `app_runtime` and `app_system` (`docker/postgres/init/02-roles.sql`) the file stops with
`database role(s) missing: …`. Every spec that applies the platform set therefore starts Postgres with
`initSql: readRolesInitSql()` or `startRlsTestPostgres()`.

The files are hand-written: drizzle-kit has nothing to diff here, and `drizzle-kit generate --custom` refuses to run
without a schema file. The runtime migrator reads only `meta/_journal.json` and the `.sql` files. To add a file:

1. create `src/platform/migrations/NNNN_<name>.sql` (next index; statements separated by `--> statement-breakpoint`);
2. append `{ "idx": N, "version": "7", "when": <Date.now()>, "tag": "NNNN_<name>", "breakpoints": true }` to
   `src/platform/migrations/meta/_journal.json`. `when` must be larger than the previous entry's: drizzle applies only
   files newer than the last applied one;
3. never edit an applied file. `platform.migrations.spec.ts` checks the journal against the folder, and the runner
   rejects a malformed journal before it connects. Grant what a new function needs in the same file: the default
   privilege leaves it unexecutable by anyone but its owner.

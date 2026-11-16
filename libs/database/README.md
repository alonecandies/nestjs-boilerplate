# @platform/database

PostgreSQL for the monorepo. It provides a tuned **postgres.js** pool, **Drizzle ORM** (a global
`DatabaseModule`), transactions that propagate through CLS (`@Transactional()`), **migration sets** applied by an
**advisory-locked** runner (at boot, or by each app's `migrate.ts` through `runMigrationsCli`), a readiness
contributor, and **uuidv7 keyset-pagination** helpers.

Domain tables live in the domain packages, each in its own Postgres schema with its own drizzle-kit config and
migration history (`domains/<x>`). This package owns the connection, the runner, the
**platform set** (schema `app`, extensions) and the rule that the platform set always runs first.

Production refuses a `DATABASE_URL` without TLS (`?sslmode=verify-full`, `require` or `verify-ca`, `ssl=true`, or
`sslrootcert=system`; as in postgres.js, the last value of a repeated parameter wins). An `ssl` option passed in
code (`DatabaseModule` `postgres.ssl`) wins at runtime, but the boot check only reads the URL: keep
`?sslmode=require` there too, or set `DATABASE_ALLOW_INSECURE=true` when a sidecar encrypts the hop.

## Public API

| Export                                                                                                                                                  | Kind             | Purpose                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DatabaseModule.forRootAsync<S>(options: DatabaseModuleOptions<S>): DynamicModule`                                                                      | module (global)  | Pool + Drizzle handle, transactional CLS plugin, migrations on boot, health indicator. Validates `migrations` when called                                                                                                         |
| `DatabaseModuleOptions<S>`                                                                                                                              | interface        | `{ schema: S; migrations: readonly DatabaseMigrationSet[]; runMigrations?; transactional?: boolean \| DatabaseTransactionalOptions; postgres?: PostgresOptions }`                                                                 |
| `DatabaseTransactionalOptions`                                                                                                                          | interface        | `{ defaultTxOptions?: PgTransactionConfig; enableTransactionProxy?: boolean }`                                                                                                                                                    |
| `DatabaseMigrationSet`                                                                                                                                  | interface        | `{ name; folder; migrationsSchema; migrationsTable }`: one migration history with its own bookkeeping table                                                                                                                       |
| `platformMigrations`                                                                                                                                    | const            | The platform set (`src/platform/migrations`, bookkeeping `app.__drizzle_migrations`): always applied first                                                                                                                        |
| `withPlatformMigrations(sets)`                                                                                                                          | fn               | `[platformMigrations, ...sets]`; throws on a set listed twice or two sets sharing a bookkeeping table                                                                                                                             |
| `DRIZZLE`, `DATABASE_MODULE_OPTIONS`                                                                                                                    | symbols          | Injection tokens                                                                                                                                                                                                                  |
| `InjectDrizzle()`                                                                                                                                       | decorator        | `@InjectDrizzle() private readonly db: DrizzleDB<typeof schema>`                                                                                                                                                                  |
| `DrizzleDB<S>`, `DrizzleTransaction<S>`, `DrizzleExecutor<S>`, `DrizzleSchema`                                                                          | types            | Handle (`PostgresJsDatabase<S> & { $client: Sql }`), tx handle, db-or-tx, schema record                                                                                                                                           |
| `DrizzleTransactionalAdapter<S>`, `DrizzleTransactionHost<S>`                                                                                           | types            | Adapter and `TransactionHost` typing for your schema                                                                                                                                                                              |
| `Transactional`, `TransactionHost`, `InjectTransaction`, `InjectTransactionHost`, `Propagation`                                                         | re-exports       | From `@nestjs-cls/transactional` (same package instance)                                                                                                                                                                          |
| `DrizzlePostgresTransactionalAdapter`, `normalizeTxConfig(config)`                                                                                      | class, fn        | Drizzle adapter that drops empty tx configs (see Gotchas)                                                                                                                                                                         |
| `runMigrations(url, options): Promise<MigrationRunSummary>`                                                                                             | fn               | Exactly `options.migrations`, in order: single-session client + `pg_try_advisory_lock` polling + drizzle `migrate()` per set                                                                                                      |
| `RunMigrationsOptions`, `MigrationRunSummary`, `MigrationSetSummary`                                                                                    | types            | `{ migrations, logger?, applicationName?, lockTimeoutMs?, lockPollIntervalMs? }` → `{ sets: [{ name, folder, total, applied }], total, applied }`                                                                                 |
| `runMigrationsCli(migrations, args?)`                                                                                                                   | fn               | Body of every app's `src/migrate.ts`: config from env, platform set + `migrations`, JSON log lines, `process.exitCode`                                                                                                            |
| `MIGRATIONS_TABLE` (`__drizzle_migrations`), `MIGRATIONS_ADVISORY_LOCK_ID`                                                                              | consts           | The bookkeeping table name of every set; the one lock key                                                                                                                                                                         |
| `DatabaseHealthIndicator`                                                                                                                               | provider         | `HealthContributor` with key `postgres` (`select 1`, 2 s timeout, cancels the query)                                                                                                                                              |
| `keysetWhere(col, cursor, dir?)`, `keysetOrder(col, dir?)`, `keysetFetchLimit(limit)`, `keysetPage(rows, limit)`, `keysetPageBy(rows, limit, cursorOf)` | fns              | Seek pagination → `CursorPage<T>` from `@platform/common`                                                                                                                                                                         |
| `encodeIdCursor(id)`, `decodeIdCursor(cursor)`, `normalizePageLimit(limit)`, `IdCursor`, `KeysetDirection`                                              | fns, types       | A bad cursor throws a 422 `INVALID_CURSOR`                                                                                                                                                                                        |
| `buildPostgresOptions(cfg, ctx, overrides?)`, `PostgresOptions`, `IDLE_IN_TRANSACTION_TIMEOUT_MS`                                                       | fn, type         | Config → postgres.js options (seconds vs ms handled)                                                                                                                                                                              |
| `createDrizzleDatabase(cfg, app, options, logger?)`                                                                                                     | fn               | The factory behind `DRIZZLE`, usable outside Nest                                                                                                                                                                                 |
| `PoolUsage(pool, max)`, `PoolUsageSnapshot`                                                                                                             | class, interface | Connection demand of one postgres.js pool: `track(client)` returns a counting wrapper (awaited top-level queries and `begin()` transactions; `reserve()`, `listen()` not counted), `snapshot()` → `{ pool, max, inUse, waiting }` |
| `registerPoolUsage(usage)`                                                                                                                              | fn               | Publishes a `PoolUsage` as the gauges below (one entry per pool name, the latest registration wins); `createDrizzleDatabase` registers `pool="runtime"`                                                                           |
| `DB_POOL_CONNECTIONS_IN_USE`, `DB_POOL_OPERATIONS_WAITING`, `DB_POOL_CONNECTIONS_MAX`                                                                   | consts           | `db_pool_connections_in_use`, `db_pool_operations_waiting`, `db_pool_connections_max`, gauges labelled `{pool}` (see [OBSERVABILITY.md](../../docs/OBSERVABILITY.md#metrics-prometheus))                                          |
| `isTransientConnectionError(e)`, `describePostgresUrl(url)`, `DrizzleQueryLogger`                                                                       | helpers          | Boot retries, credential-free log target, SQL debug logging                                                                                                                                                                       |

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
import { type DrizzleTransactionalAdapter, keysetFetchLimit, keysetOrder, keysetPage, keysetWhere, TransactionHost } from '@platform/database';

@Injectable()
export class DrizzleOrdersRepository {
  // TransactionHost is a class → imported as a VALUE (DI by type). txHost.tx = the active tx or the pool.
  constructor(private readonly txHost: TransactionHost<DrizzleTransactionalAdapter<typeof ordersSchema>>) {}

  async list(q: { limit: number; cursor?: string }) {
    const rows = await this.txHost.tx.select().from(orders)
      .where(keysetWhere(orders.id, q.cursor))  // id < cursor (uuidv7 = time-ordered)
      .orderBy(keysetOrder(orders.id))          // ORDER BY id DESC
      .limit(keysetFetchLimit(q.limit));        // limit + 1 look-ahead
    return keysetPage(rows, q.limit);           // { items, nextCursor }
  }
}

// a command handler: both writes commit or roll back together, no tx argument threading
@Transactional()
async execute(cmd: PlaceOrderCommand) { await this.orders.insert(...); await this.lineItems.insert(...); }
```

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
- Each set's pending files run in one transaction (all-or-nothing per set); a set that already ran stays applied when
  a later set fails.

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

Set `DATABASE_RUN_MIGRATIONS=true` (or `runMigrations: true`) to migrate at boot. In production, prefer each app's
`dist/migrate.js` as a one-off job.

## Environment (`database` namespace, plus `SERVICE_NAME` from `app`)

`DATABASE_URL`, `DATABASE_POOL_MAX` (20), `DATABASE_IDLE_TIMEOUT_SEC` (30), `DATABASE_MAX_LIFETIME_SEC` (1800),
`DATABASE_CONNECT_TIMEOUT_SEC` (10), `DATABASE_STATEMENT_TIMEOUT_MS` (15000), `DATABASE_PREPARE` (true; false behind
PgBouncer transaction mode / RDS Proxy), `DATABASE_LOG_QUERIES` (false; params are logged only outside production),
`DATABASE_RUN_MIGRATIONS` (false). `SERVICE_NAME` becomes the session's `application_name`. Every session also gets
`idle_in_transaction_session_timeout=60s` and `TimeZone=UTC`.

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
  failure they avoid), with the `test/fixtures/citus` set.

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
- The compose and testcontainers role is `app`, and the platform set creates schema `app`: the default `search_path`
  (`"$user", public`) then starts with `app`, so unqualified DDL run as that role lands in `app`. Qualify names in
  hand-written SQL.
- Pass `date.toISOString()` for a JS `Date` inside a raw ` sql` `` template, not the `Date` itself. Operators
  (`lt(col, date)`) are fine.
- `migrate()` runs a set's pending migrations in **one transaction**, so `CREATE INDEX CONCURRENTLY` is impossible.
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

The files are hand-written: drizzle-kit has nothing to diff here, and `drizzle-kit generate --custom` refuses to run
without a schema file. The runtime migrator reads only `meta/_journal.json` and the `.sql` files. To add a file:

1. create `src/platform/migrations/NNNN_<name>.sql` (next index; statements separated by `--> statement-breakpoint`);
2. append `{ "idx": N, "version": "7", "when": <Date.now()>, "tag": "NNNN_<name>", "breakpoints": true }` to
   `src/platform/migrations/meta/_journal.json`. `when` must be larger than the previous entry's: drizzle applies only
   files newer than the last applied one;
3. never edit an applied file. `platform.migrations.spec.ts` checks the journal against the folder, and the runner
   rejects a malformed journal before it connects.

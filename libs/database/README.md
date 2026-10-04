# @app/database

PostgreSQL for the monorepo. It provides a tuned **postgres.js** pool, **Drizzle ORM** (a global
`DatabaseModule`), transactions that propagate through CLS (`@Transactional()`), drizzle-kit
migrations applied by an **advisory-locked** runner (at boot or from the `migrate.ts` CLI), a
readiness contributor, and **uuidv7 keyset-pagination** helpers.

Domain tables live in the domain libs as `*.schema.ts` files (identity, billing). This package
owns the connection, the migration history and the tooling.

## Public API

| Export                                                                                                                                                  | Kind            | Purpose                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `DatabaseModule.forRootAsync<S>(options: DatabaseModuleOptions<S>): DynamicModule`                                                                      | module (global) | Pool + Drizzle handle, transactional CLS plugin, migrations on boot, health indicator                                                   |
| `DatabaseModuleOptions<S>`                                                                                                                              | interface       | `{ schema: S; migrationsFolder?; runMigrations?; transactional?: boolean \| DatabaseTransactionalOptions; postgres?: PostgresOptions }` |
| `DatabaseTransactionalOptions`                                                                                                                          | interface       | `{ defaultTxOptions?: PgTransactionConfig; enableTransactionProxy?: boolean }`                                                          |
| `DRIZZLE`, `DATABASE_MODULE_OPTIONS`                                                                                                                    | symbols         | Injection tokens                                                                                                                        |
| `InjectDrizzle()`                                                                                                                                       | decorator       | `@InjectDrizzle() private readonly db: DrizzleDB<typeof schema>`                                                                        |
| `DrizzleDB<S>`, `DrizzleTransaction<S>`, `DrizzleExecutor<S>`, `DrizzleSchema`                                                                          | types           | Handle (`PostgresJsDatabase<S> & { $client: Sql }`), tx handle, db-or-tx, schema record                                                 |
| `DrizzleTransactionalAdapter<S>`, `DrizzleTransactionHost<S>`                                                                                           | types           | Adapter and `TransactionHost` typing for your schema                                                                                    |
| `Transactional`, `TransactionHost`, `InjectTransaction`, `InjectTransactionHost`, `Propagation`                                                         | re-exports      | From `@nestjs-cls/transactional` (same package instance)                                                                                |
| `DrizzlePostgresTransactionalAdapter`, `normalizeTxConfig(config)`                                                                                      | class, fn       | Drizzle adapter that drops empty tx configs (see Gotchas)                                                                               |
| `runMigrations(url, options?): Promise<MigrationRunSummary>`                                                                                            | fn              | Single-session client + `pg_try_advisory_lock` polling + drizzle `migrate()`                                                            |
| `RunMigrationsOptions`, `MigrationRunSummary`, `DEFAULT_MIGRATIONS_FOLDER`                                                                              | types, const    | `{ migrationsFolder?, logger?, applicationName?, lockTimeoutMs?, lockPollIntervalMs? }` → `{ folder, total, applied }`                  |
| `MIGRATIONS_SCHEMA` (`public`), `MIGRATIONS_TABLE` (`__drizzle_migrations`), `MIGRATIONS_ADVISORY_LOCK_ID`                                              | consts          | Shared with `drizzle.config.ts`                                                                                                         |
| `DatabaseHealthIndicator`                                                                                                                               | provider        | `HealthContributor` with key `postgres` (`select 1`, 2 s timeout, cancels the query)                                                    |
| `keysetWhere(col, cursor, dir?)`, `keysetOrder(col, dir?)`, `keysetFetchLimit(limit)`, `keysetPage(rows, limit)`, `keysetPageBy(rows, limit, cursorOf)` | fns             | Seek pagination → `CursorPage<T>` from `@app/common`                                                                                    |
| `encodeIdCursor(id)`, `decodeIdCursor(cursor)`, `normalizePageLimit(limit)`, `IdCursor`, `KeysetDirection`                                              | fns, types      | A bad cursor throws a 422 `INVALID_CURSOR`                                                                                              |
| `buildPostgresOptions(cfg, ctx, overrides?)`, `PostgresOptions`, `IDLE_IN_TRANSACTION_TIMEOUT_MS`                                                       | fn, type        | Config → postgres.js options (seconds vs ms handled)                                                                                    |
| `createDrizzleDatabase(cfg, app, options, logger?)`                                                                                                     | fn              | The factory behind `DRIZZLE`, usable outside Nest                                                                                       |
| `isTransientConnectionError(e)`, `describePostgresUrl(url)`, `DrizzleQueryLogger`                                                                       | helpers         | Boot retries, credential-free log target, SQL debug logging                                                                             |

## Usage

```ts
// app.module.ts
import { identitySchema } from '@app/identity'; // the domain lib's tables + relations record
@Module({
  imports: [
    AppConfigModule.forRoot(),
    ObservabilityModule.forRoot({ healthContributors: [DatabaseHealthIndicator] }),
    DatabaseModule.forRootAsync({ schema: identitySchema }), // monolith: { ...identitySchema, ...billingSchema }
  ],
})
export class AppModule {}

// users.repository.ts (infrastructure layer)
import { type DrizzleTransactionalAdapter, keysetFetchLimit, keysetOrder, keysetPage, keysetWhere, TransactionHost } from '@app/database';

@Injectable()
export class DrizzleUsersRepository {
  // TransactionHost is a class → imported as a VALUE (DI by type). txHost.tx = the active tx or the pool.
  constructor(private readonly txHost: TransactionHost<DrizzleTransactionalAdapter<typeof schema>>) {}

  async list(q: { limit: number; cursor?: string }) {
    const rows = await this.txHost.tx.select().from(users)
      .where(keysetWhere(users.id, q.cursor))   // id < cursor (uuidv7 = time-ordered)
      .orderBy(keysetOrder(users.id))           // ORDER BY id DESC
      .limit(keysetFetchLimit(q.limit));        // limit + 1 look-ahead
    return keysetPage(rows, q.limit);           // { items, nextCursor }
  }
}

// a command handler: both writes commit or roll back together, no tx argument threading
@Transactional()
async execute(cmd: RegisterUserCommand) { await this.users.insert(...); await this.sessions.insert(...); }
```

Migrations:

```bash
bun run db:generate        # drizzle-kit generate → libs/database/src/migrations (commit the output)
bun run db:migrate         # node dist/migrate.js (after build); [--migrations-folder <dir>]
bun run db:migrate:dev     # same, from TS sources
bun run db:studio
```

The `migrate.ts` CLI logs one JSON object per line (`ConsoleLogger({ json: true })`, what log shippers ingest
from deploy jobs); `LOG_PRETTY=true` (default in development) switches to coloured text. Exit code 0 = schema
current, 1 = failure.

`src/migrations/0000_init.sql` is the committed initial migration for identity + billing: the `user_role`
and `payment_status` enums, `users` (unique `users_email_unique`), `sessions` (FK `user_id → users.id`
`ON DELETE CASCADE`, `sessions_user_id_idx`, `sessions_expires_at_idx`), `payments` (unique
`payments_stripe_checkout_session_id_unique`, `payments_user_id_id_idx`, unique
`payments_user_id_idempotency_key_uq`) and `stripe_events`. Both uuid primary keys default to PG18's
`uuidv7()`. `0001_users_search_trgm.sql` adds `CREATE EXTENSION IF NOT EXISTS pg_trgm` (hand-added on top of
the generated SQL) and the `users_search_trgm_idx` GIN index (`email`, `display_name` `gin_trgm_ops`) for the
identity user search. Identity's `users.repository.int-spec.ts` applies them to a real Postgres 18. Schema changes: edit a
domain `*.schema.ts`, run `db:generate --name <change>`, commit the new file plus `meta/`. Never edit an applied
migration.

Set `DATABASE_RUN_MIGRATIONS=true` (or `runMigrations: true`) to migrate at boot. Replicas that boot
together are serialised by the advisory lock. In production, prefer running the CLI as a one-off job.

## Environment (`database` namespace, plus `SERVICE_NAME` from `app`)

`DATABASE_URL`, `DATABASE_POOL_MAX` (20), `DATABASE_IDLE_TIMEOUT_SEC` (30), `DATABASE_MAX_LIFETIME_SEC` (1800),
`DATABASE_CONNECT_TIMEOUT_SEC` (10), `DATABASE_STATEMENT_TIMEOUT_MS` (15000), `DATABASE_PREPARE` (true; false behind
PgBouncer transaction mode / RDS Proxy), `DATABASE_LOG_QUERIES` (false; params are logged only outside production),
`DATABASE_RUN_MIGRATIONS` (false). `SERVICE_NAME` becomes the session's `application_name`. Every session also gets
`idle_in_transaction_session_timeout=60s` and `TimeZone=UTC`.

## Tests

- Unit (`bunx vitest run --project database`) needs no database. `test/fake-sql.ts` fakes the postgres.js pool
  (`unsafe`, `begin`, `end`), so drizzle's real session code runs: module wiring, `@Transactional()` commit and
  rollback, boot retries, the migration lock and health are all covered.
- Integration (`INTEGRATION=1 bunx vitest run --project database:int`) uses `postgres:18.6-alpine3.24` through
  testcontainers. It covers concurrent `runMigrations`, the CLI, boot migrations, startup GUCs, `uuidv7()` defaults,
  transactions, keyset paging, health and shutdown. The fixtures in `test/fixtures/migrations` are real drizzle-kit
  output: `drizzle-kit generate --dialect=postgresql --schema=./test/fixtures/widgets.schema.ts --out=./test/fixtures/migrations --casing=snake_case`.

## Gotchas

- **`@Transactional()` needs no `ClsModule.forRoot`**: this module registers its plugin with
  `ClsModule.registerPlugins()`. `@app/observability` owns `ClsModule.forRoot` (request ids), and the two compose.
  Never pass `DatabaseModule` in a plugin's `imports`, because that creates a second copy with no options.
- **Empty tx options break drizzle**: `TransactionHost` always passes the merged options object (`{}` by default),
  and drizzle renders `{}` as `set transaction ` (a 42601 syntax error on a real server). Our adapter drops empty
  configs. If you register your own plugin (`transactional: false`), use `DrizzlePostgresTransactionalAdapter`.
- `DrizzleDB` is a type alias: inject it with `@InjectDrizzle()` and import the type with `import type`.
  `TransactionHost` is a class and must be imported as a value.
- `*.schema.ts` files may import only `drizzle-orm*` and relative files, because drizzle-kit loads them with its own
  loader. `casing: 'snake_case'` must match in `drizzle.config.ts` and at runtime. Raw SQL still uses snake_case.
- Pass `date.toISOString()` for a JS `Date` inside a raw ` sql` `` template, not the `Date` itself. Operators
  (`lt(col, date)`) are fine.
- `migrate()` runs every pending migration in **one transaction**, so `CREATE INDEX CONCURRENTLY` is impossible.
  A migration whose journal timestamp is older than the last applied one is **silently skipped**: regenerate after
  merges and run `drizzle-kit check` in CI.
- Build prepared statements in the constructor body, never in field initialisers.
- Keyset indexes: a plain ASC btree is scanned backwards for `DESC`. Drizzle's `.desc()` emits `NULLS LAST`, which
  does not match `ORDER BY … DESC`.
- `drizzle.config.ts` drops globs that match nothing, so `drizzle-kit check/studio` work before any domain
  schema exists. `generate` still reports "No schema files found".

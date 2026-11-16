import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger, type LoggerService } from '@nestjs/common';
import { sleep } from '@platform/common';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { noop, sumBy } from 'lodash-es';
import postgres, { type Sql } from 'postgres';
import { z } from 'zod';
import type { DatabaseMigrationSet } from '../database.types.js';
import { MIGRATIONS_ADVISORY_LOCK_ID } from './migrations.constants.js';

export interface RunMigrationsOptions {
  /**
   * The sets to apply, in this order, exactly as given. `DatabaseModule` and `runMigrationsCli`
   * pass `withPlatformMigrations(appSets)`, so the platform set comes first.
   */
  migrations: readonly DatabaseMigrationSet[];
  logger?: LoggerService;
  /** `application_name` prefix of the migration session (shown in `pg_stat_activity`). */
  applicationName?: string;
  /** Max time to wait for another instance's migration run to release the lock. Default 5 min. */
  lockTimeoutMs?: number;
  /** How often to retry the advisory lock while another instance holds it. Default 1 s. */
  lockPollIntervalMs?: number;
}

export interface MigrationSetSummary {
  name: string;
  folder: string;
  /** Migrations listed in the set's journal (0 when the folder has no journal yet). */
  total: number;
  /** Applied by THIS run — 0 when the set was already current (e.g. another replica won). */
  applied: number;
}

export interface MigrationRunSummary {
  /** One entry per set, in the order they were applied. */
  sets: MigrationSetSummary[];
  /** Sums over `sets`. */
  total: number;
  applied: number;
}

const DEFAULT_LOCK_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_LOCK_POLL_INTERVAL_MS = 1_000;

/**
 * What drizzle's migrator reads from each journal entry: `tag` names the `.sql` file, `when` becomes
 * the bookkeeping row's `created_at`, `breakpoints` how the file is split. drizzle applies only the
 * files whose `when` is newer than the last applied row, so `when` must be a positive integer that
 * grows within the set: an entry without one (or an older one) would be skipped silently.
 */
const journalSchema = z.object({
  entries: z
    .array(z.object({ tag: z.string(), when: z.int().positive(), breakpoints: z.boolean() }))
    .superRefine((entries, ctx) => {
      for (const [index, entry] of entries.entries()) {
        const previous = entries[index - 1];
        if (previous !== undefined && entry.when <= previous.when) {
          ctx.addIssue({
            code: 'custom',
            path: [index, 'when'],
            message: `must be greater than the previous entry's (${previous.when}): drizzle skips a file that is not newer than the last applied one`,
          });
        }
      }
    }),
});

/** Number of journal entries, or `null` when the folder has no drizzle journal yet. */
function readJournalSize(folder: string): number | null {
  const journalPath = join(folder, 'meta', '_journal.json');
  if (!existsSync(journalPath)) return null;
  const journal = journalSchema.safeParse(JSON.parse(readFileSync(journalPath, 'utf8')));
  if (!journal.success) {
    throw new Error(
      `Invalid drizzle migration journal: ${journalPath}\n${z.prettifyError(journal.error)}`,
    );
  }
  return journal.data.entries.length;
}

/**
 * Polls `pg_try_advisory_lock` instead of blocking in `pg_advisory_lock`, so a waiting replica
 * logs why it is stuck and gives up after `timeoutMs` instead of hanging its boot forever.
 */
async function acquireMigrationLock(
  sql: Sql,
  timeoutMs: number,
  pollIntervalMs: number,
  logger: LoggerService,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 1; ; attempt++) {
    const [row] = await sql<{ locked: boolean }[]>`
      select pg_try_advisory_lock(${MIGRATIONS_ADVISORY_LOCK_ID}) as locked`;
    if (row?.locked === true) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for the migrations advisory lock ` +
          `(${MIGRATIONS_ADVISORY_LOCK_ID}); another instance is still migrating or its session is stuck`,
      );
    }
    if (attempt === 1) logger.log('Another instance is running migrations — waiting for its lock');
    await sleep(pollIntervalMs);
  }
}

/**
 * Rows in the set's own bookkeeping table (0 before its first run). The schema and table names are
 * quoted (`%I`) like drizzle quotes them, so a mixed-case schema is found instead of case-folded.
 */
async function countAppliedMigrations(sql: Sql, set: DatabaseMigrationSet): Promise<number> {
  const [table] = await sql<{ exists: boolean }[]>`
    select to_regclass(format('%I.%I', ${set.migrationsSchema}::text, ${set.migrationsTable}::text))
      is not null as exists`;
  if (table?.exists !== true) return 0;
  const [row] = await sql<{ count: number }[]>`
    select count(*)::int as count from ${sql(set.migrationsSchema)}.${sql(set.migrationsTable)}`;
  return row?.count ?? 0;
}

async function applySet(
  sql: Sql,
  set: DatabaseMigrationSet,
  total: number,
  logger: LoggerService,
): Promise<MigrationSetSummary> {
  const before = await countAppliedMigrations(sql, set);
  await migrate(drizzle({ client: sql }), {
    migrationsFolder: set.folder,
    migrationsSchema: set.migrationsSchema,
    migrationsTable: set.migrationsTable,
  });
  const applied = Math.max(0, (await countAppliedMigrations(sql, set)) - before);
  logger.log(
    applied > 0
      ? `${set.name}: applied ${applied} migration(s); ${total} in total`
      : `${set.name}: schema is up to date (${total} migrations)`,
  );
  return { name: set.name, folder: set.folder, total, applied };
}

const summarize = (sets: MigrationSetSummary[]): MigrationRunSummary => ({
  sets,
  total: sumBy(sets, 'total'),
  applied: sumBy(sets, 'applied'),
});

/**
 * drizzle applies a set's pending files in ONE transaction; on Citus two settings make that work:
 * - local execution on: with it off (a `localExecution: false` test server, or a role default),
 *   the coordinator creates its own shards over a loopback connection that cannot see a schema or
 *   enum created earlier in the same transaction, so a fresh database's `0000_init` plus its
 *   `distribute` file fail with `type "<schema>.<enum>" does not exist`;
 * - sequential shard modification: DDL on a table with a reference-table foreign key fails after
 *   any parallel shard operation in the same transaction (shards on workers), so one file can
 *   distribute tables and then add their foreign keys only in this mode (sharding design P-10).
 * Session `SET`s are safe: this client is private (`max: 1`) and must reach the coordinator
 * directly, never through a transaction pooler. Without the citus extension nothing is sent.
 */
async function configureCitusSession(sql: Sql, logger: LoggerService): Promise<void> {
  const [row] = await sql<{ citus: boolean }[]>`
    select exists (select 1 from pg_extension where extname = 'citus') as citus`;
  if (row?.citus !== true) return;
  await sql`set citus.enable_local_execution to on`;
  await sql`set citus.multi_shard_modify_mode to 'sequential'`;
  logger.log(
    'Citus detected: migration session uses local execution and sequential shard modification',
  );
}

/**
 * Applies the pending drizzle-kit migrations of several sets, in order, safely under concurrency:
 * - ONE advisory lock around every set, so different services sharing a database migrate one
 *   after the other;
 * - a dedicated `max: 1` client so the session-level lock and every `migrate()` share ONE
 *   connection (`max_lifetime: null` — a recycled socket would silently drop the lock);
 * - `statement_timeout: 0` for this session only: DDL / backfills may legitimately run long;
 * - on Citus (the `citus` extension is installed), `citus.enable_local_execution = on` and
 *   `citus.multi_shard_modify_mode = 'sequential'` for this session, so a set can create a schema
 *   or enum, distribute tables and add their foreign keys in one transaction;
 * - each set writes its own bookkeeping table: drizzle applies only files newer than the LAST row
 *   of that table, so a shared table would skip the files of the set with older timestamps;
 * - drizzle runs a set's pending migrations in one transaction (all-or-nothing per set), so
 *   `CREATE INDEX CONCURRENTLY` cannot be used; a set that already ran stays applied when a later
 *   set fails;
 * - a failing set stops the run (the sets after it are not attempted) with an error that names it
 *   and carries the driver's error as `cause`.
 *
 * Every journal is read before connecting: a malformed one (an entry without a string `tag`, a
 * positive integer `when` or a boolean `breakpoints`, or a `when` that does not grow) fails the run
 * up front, naming the entry. A set whose folder has no `meta/_journal.json` yet is skipped with a
 * warning; when no set has one, nothing connects.
 */
export async function runMigrations(
  url: string,
  options: RunMigrationsOptions,
): Promise<MigrationRunSummary> {
  const logger = options.logger ?? new Logger('DatabaseMigrations');
  const plan = options.migrations.map((set) => ({ set, total: readJournalSize(set.folder) }));
  const skipped = (set: DatabaseMigrationSet): MigrationSetSummary => ({
    name: set.name,
    folder: set.folder,
    total: 0,
    applied: 0,
  });
  for (const { set, total } of plan) {
    if (total === null) {
      logger.warn(
        `No drizzle migrations for "${set.name}" in ${set.folder} (meta/_journal.json missing) — skipping`,
      );
    }
  }
  if (plan.every(({ total }) => total === null)) {
    return summarize(plan.map(({ set }) => skipped(set)));
  }

  const sql = postgres(url, {
    max: 1,
    max_lifetime: null,
    prepare: false,
    onnotice: (notice) => {
      logger.debug?.(notice['message'] ?? 'notice');
    },
    connection: {
      application_name: `${options.applicationName ?? 'app'}:migrate`,
      statement_timeout: 0,
    },
  });
  let locked = false;
  try {
    await acquireMigrationLock(
      sql,
      options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
      options.lockPollIntervalMs ?? DEFAULT_LOCK_POLL_INTERVAL_MS,
      logger,
    );
    locked = true;
    await configureCitusSession(sql, logger);
    const results: MigrationSetSummary[] = [];
    for (const { set, total } of plan) {
      if (total === null) {
        results.push(skipped(set));
        continue;
      }
      try {
        results.push(await applySet(sql, set, total, logger));
      } catch (error) {
        throw new Error(`Migration set "${set.name}" (${set.folder}) failed`, { cause: error });
      }
    }
    return summarize(results);
  } finally {
    if (locked) await sql`select pg_advisory_unlock(${MIGRATIONS_ADVISORY_LOCK_ID})`.catch(noop);
    await sql.end({ timeout: 5 });
  }
}

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sleep } from '@app/common';
import { Logger, type LoggerService } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { noop } from 'lodash-es';
import postgres, { type Sql } from 'postgres';
import { z } from 'zod';
import {
  MIGRATIONS_ADVISORY_LOCK_ID,
  MIGRATIONS_SCHEMA,
  MIGRATIONS_TABLE,
} from './migrations.constants.js';

/**
 * drizzle-kit output folder (`src/migrations` in dev, `dist/migrations` after the build — SWC
 * `copyFiles` copies the .sql files and `meta/_journal.json`).
 */
export const DEFAULT_MIGRATIONS_FOLDER = join(import.meta.dirname, '..', 'migrations');

export interface RunMigrationsOptions {
  /** Folder containing drizzle-kit output (`meta/_journal.json` + `NNNN_*.sql`). */
  migrationsFolder?: string;
  logger?: LoggerService;
  /** `application_name` prefix of the migration session (shown in `pg_stat_activity`). */
  applicationName?: string;
  /** Max time to wait for another instance's migration run to release the lock. Default 5 min. */
  lockTimeoutMs?: number;
  /** How often to retry the advisory lock while another instance holds it. Default 1 s. */
  lockPollIntervalMs?: number;
}

export interface MigrationRunSummary {
  folder: string;
  /** Migrations listed in the journal. */
  total: number;
  /** Applied by THIS run — 0 when the schema was already current (e.g. another replica won). */
  applied: number;
}

const DEFAULT_LOCK_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_LOCK_POLL_INTERVAL_MS = 1_000;

const journalSchema = z.object({ entries: z.array(z.object({ tag: z.string() })) });

/** Number of journal entries, or `null` when the folder has no drizzle journal yet. */
function readJournalSize(folder: string): number | null {
  const journalPath = join(folder, 'meta', '_journal.json');
  if (!existsSync(journalPath)) return null;
  const journal = journalSchema.safeParse(JSON.parse(readFileSync(journalPath, 'utf8')));
  if (!journal.success) throw new Error(`Invalid drizzle migration journal: ${journalPath}`);
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

async function countAppliedMigrations(sql: Sql): Promise<number> {
  const [table] = await sql<{ exists: boolean }[]>`
    select to_regclass(${`${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE}`}) is not null as exists`;
  if (table?.exists !== true) return 0;
  const [row] = await sql<{ count: number }[]>`
    select count(*)::int as count from ${sql(MIGRATIONS_SCHEMA)}.${sql(MIGRATIONS_TABLE)}`;
  return row?.count ?? 0;
}

/**
 * Applies pending drizzle-kit migrations, safely under concurrency:
 * - a dedicated `max: 1` client so the session-level advisory lock and `migrate()` share ONE
 *   connection (`max_lifetime: null` — a recycled socket would silently drop the lock);
 * - `statement_timeout: 0` for this session only: DDL / backfills may legitimately run long;
 * - drizzle runs all pending migrations in a single transaction (all-or-nothing), which also
 *   means `CREATE INDEX CONCURRENTLY` cannot be used in these migrations.
 *
 * A folder without `meta/_journal.json` (no migrations generated yet) is skipped with a warning.
 */
export async function runMigrations(
  url: string,
  options: RunMigrationsOptions = {},
): Promise<MigrationRunSummary> {
  const folder = options.migrationsFolder ?? DEFAULT_MIGRATIONS_FOLDER;
  const logger = options.logger ?? new Logger('DatabaseMigrations');
  const total = readJournalSize(folder);
  if (total === null) {
    logger.warn(`No drizzle migrations in ${folder} (meta/_journal.json missing) — skipping`);
    return { folder, total: 0, applied: 0 };
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
    const before = await countAppliedMigrations(sql);
    await migrate(drizzle({ client: sql }), {
      migrationsFolder: folder,
      migrationsSchema: MIGRATIONS_SCHEMA,
      migrationsTable: MIGRATIONS_TABLE,
    });
    const applied = Math.max(0, (await countAppliedMigrations(sql)) - before);
    logger.log(
      applied > 0
        ? `Applied ${applied} migration(s); ${total} in total`
        : `Database schema is up to date (${total} migrations)`,
    );
    return { folder, total, applied };
  } finally {
    if (locked) await sql`select pg_advisory_unlock(${MIGRATIONS_ADVISORY_LOCK_ID})`.catch(noop);
    await sql.end({ timeout: 5 });
  }
}

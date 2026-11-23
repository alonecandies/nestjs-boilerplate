import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Logger, type LoggerService } from '@nestjs/common';
import { retry, sleep } from '@platform/common';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { noop, sumBy } from 'lodash-es';
import postgres, { type Sql } from 'postgres';
import { z } from 'zod';
import type { DatabaseMigrationSet } from '../database.types.js';
import { assertMigrationSets } from './migration-sets.js';
import { MIGRATIONS_ADVISORY_LOCK_ID, ONLINE_MIGRATIONS_TABLE } from './migrations.constants.js';

export interface RunMigrationsOptions {
  /**
   * The sets to apply, in this order, exactly as given: the platform set first, each set with its
   * own bookkeeping table and journal (`assertMigrationSets`). `DatabaseModule` and
   * `runMigrationsCli` pass `withPlatformMigrations(appSets)`.
   */
  migrations: readonly DatabaseMigrationSet[];
  logger?: LoggerService;
  /** `application_name` prefix of the migration session (shown in `pg_stat_activity`). */
  applicationName?: string;
  /** Max time to wait for another instance's migration run to release the lock. Default 5 min. */
  lockTimeoutMs?: number;
  /** How often to retry the advisory lock while another instance holds it. Default 1 s. */
  lockPollIntervalMs?: number;
  /**
   * Postgres `lock_timeout` of the migration session, in ms (`DATABASE_MIGRATION_LOCK_TIMEOUT_MS`):
   * a statement that waits longer for a table lock fails with 55P03 instead of queueing every query
   * on that table behind it. Sent as a startup parameter; on Citus also kept as the connecting
   * role's default, which is what the session's worker connections start with. 0 = no limit.
   * Default 5000. Not the advisory-lock budget, which is `lockTimeoutMs`.
   */
  lockWaitTimeoutMs?: number;
  /** Retries of a set that failed with 55P03 (`DATABASE_MIGRATION_LOCK_RETRIES`). Default 5. */
  lockWaitRetries?: number;
  /** Backoff before the first such retry; it doubles per retry, up to 30 s. Default 1 s. */
  lockWaitRetryDelayMs?: number;
  /**
   * `lock_timeout` in ms of the separate session that runs the sets' online steps
   * (`DATABASE_MIGRATION_ONLINE_LOCK_TIMEOUT_MS`); on Citus also the role default while they run.
   * Default 0 = wait: a lock timeout cancels a concurrent index build and leaves an invalid index.
   */
  onlineLockTimeoutMs?: number;
}

/** Online steps of a set or a run: files listed, and files applied by THIS run. */
export interface OnlineStepsSummary {
  total: number;
  applied: number;
}

export interface MigrationSetSummary {
  name: string;
  folder: string;
  /** Migrations listed in the set's journal. */
  total: number;
  /** Applied by THIS run — 0 when the set was already current (e.g. another replica won). */
  applied: number;
  /** The set's online steps (`onlineFolder`); `{ total: 0, applied: 0 }` without any. */
  online: OnlineStepsSummary;
}

export interface MigrationRunSummary {
  /** One entry per set, in the order they were applied. */
  sets: MigrationSetSummary[];
  /** Sums over `sets`: `total` and `applied` count transactional files, `online` online steps. */
  total: number;
  applied: number;
  online: OnlineStepsSummary;
}

const DEFAULT_LOCK_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_LOCK_POLL_INTERVAL_MS = 1_000;
const DEFAULT_LOCK_WAIT_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_WAIT_RETRIES = 5;
const DEFAULT_LOCK_WAIT_RETRY_DELAY_MS = 1_000;
const MAX_LOCK_WAIT_RETRY_DELAY_MS = 30_000;

/** SQLSTATE lock_not_available: a lock wait exceeded `lock_timeout`. */
const LOCK_NOT_AVAILABLE = '55P03';

/** The migration session's lock-wait policy, resolved from the options. */
interface LockWaitPolicy {
  timeoutMs: number;
  retries: number;
  retryDelayMs: number;
}

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

/** Number of journal entries; a set whose folder has no drizzle journal fails the run. */
function readJournalSize(set: DatabaseMigrationSet): number {
  return readJournal(set).entries.length;
}

/** The set's parsed drizzle journal; a missing or invalid journal fails the run. */
function readJournal(set: DatabaseMigrationSet): z.infer<typeof journalSchema> {
  const journalPath = join(set.folder, 'meta', '_journal.json');
  if (!existsSync(journalPath)) {
    throw new Error(
      `Migration set "${set.name}" has no drizzle journal (${journalPath}): generate its first migration, or leave the set out`,
    );
  }
  const journal = journalSchema.safeParse(JSON.parse(readFileSync(journalPath, 'utf8')));
  if (!journal.success) {
    throw new Error(
      `Invalid drizzle migration journal: ${journalPath}\n${z.prettifyError(journal.error)}`,
    );
  }
  return journal.data;
}

/** A Postgres identifier as written: double-quoted (kept exactly) or bare (folded to lower case). */
const IDENTIFIER = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][\w$]*)`;

/** Any `CREATE [UNIQUE] INDEX CONCURRENTLY`, named or not. */
const ANY_INDEX_CONCURRENTLY = /^\s*create\s+(?:unique\s+)?index\s+concurrently\b/i;

/**
 * `CREATE [UNIQUE] INDEX CONCURRENTLY IF NOT EXISTS <index> ON [ONLY] <table>`: the only form an
 * online step may take (`readOnlineSteps`).
 */
const CREATE_INDEX_CONCURRENTLY = new RegExp(
  String.raw`^\s*create\s+(?:unique\s+)?index\s+concurrently\s+if\s+not\s+exists\s+` +
    String.raw`(${IDENTIFIER})\s+on\s+(?:only\s+)?(${IDENTIFIER}(?:\.${IDENTIFIER})?)`,
  'i',
);

/** One file of a set's `onlineFolder`: a single statement, run outside a transaction. */
interface OnlineStep {
  /** The file name, also its bookkeeping key (`__online_migrations.name`). */
  name: string;
  path: string;
  statement: string;
}

/** `NNNN_<name>.sql`: the number orders the files, as drizzle-kit numbers its own. */
const ONLINE_STEP_FILE = /^(\d{4})_[\w-]+\.sql$/;

/** SQL text without its comments: enough to see whether a file holds a statement, and which. */
const withoutComments = (text: string): string =>
  text.replaceAll(/\/\*[\s\S]*?\*\//g, ' ').replaceAll(/--[^\n]*/g, ' ');

/**
 * The set's online steps in file order, read before connecting like the journal: a declared folder
 * that is missing, a file that is not `NNNN_<name>.sql`, two files with one number or a file with
 * no statement fail the run up front. One statement per file is enforced by the server (the file
 * is sent on the extended protocol, which refuses several commands).
 */
function readOnlineSteps(set: DatabaseMigrationSet): OnlineStep[] {
  const folder = set.onlineFolder;
  if (folder === undefined) return [];
  if (!existsSync(folder) || !statSync(folder).isDirectory()) {
    throw new Error(
      `Migration set "${set.name}" declares online steps in ${folder}, which does not exist`,
    );
  }
  const numbers = new Map<string, string>();
  return readdirSync(folder)
    .toSorted()
    .map((name) => {
      const number = ONLINE_STEP_FILE.exec(name)?.[1];
      if (number === undefined) {
        throw new Error(
          `Migration set "${set.name}": online folder ${folder} holds "${name}"; only NNNN_<name>.sql files, one statement each, belong there`,
        );
      }
      const other = numbers.get(number);
      if (other !== undefined) {
        throw new Error(
          `Migration set "${set.name}": online steps "${other}" and "${name}" share the number ${number}`,
        );
      }
      numbers.set(number, name);
      const path = join(folder, name);
      const statement = readFileSync(path, 'utf8');
      const code = withoutComments(statement);
      if (code.replaceAll(';', ' ').trim() === '') {
        throw new Error(
          `Migration set "${set.name}": online step ${name} (${path}) holds no statement`,
        );
      }
      if (ANY_INDEX_CONCURRENTLY.test(code) && !CREATE_INDEX_CONCURRENTLY.test(code)) {
        throw new Error(
          `Migration set "${set.name}": online step ${name} (${path}) must name its index and say ` +
            'IF NOT EXISTS (CREATE INDEX CONCURRENTLY IF NOT EXISTS <name> ON <table> …): the ' +
            'runner finds an invalid index left by a failed build by that name, and a rerun must ' +
            'skip a built one',
        );
      }
      return { name, path, statement };
    });
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

/**
 * A database whose latest applied migration is older than the set's FIRST journal entry was migrated
 * by a history that has since been squashed into a new baseline (SH-12) and stopped part-way. drizzle
 * would replay the baseline on top of it and fail with an opaque "already exists"; refuse it with the
 * fix instead. A database at the squashed history's tip carries the baseline's own timestamp (the
 * squash keeps it), so it passes and drizzle skips the baseline.
 */
async function assertNotOlderThanBaseline(sql: Sql, set: DatabaseMigrationSet): Promise<void> {
  const firstWhen = readJournal(set).entries[0]?.when;
  if (firstWhen === undefined) return;
  const [row] = await sql<{ latest: string | null }[]>`
    select max(created_at)::text as latest
    from ${sql(set.migrationsSchema)}.${sql(set.migrationsTable)}`;
  const latest = row?.latest === null || row?.latest === undefined ? null : Number(row.latest);
  if (latest !== null && latest < firstWhen) {
    throw new Error(
      `Migration set "${set.name}": the database's latest applied migration (${latest}) is older than ` +
        `the set's first migration (${firstWhen}); its history was squashed into a new baseline. ` +
        'Recreate this database (for compose: docker compose down -v), then migrate again.',
    );
  }
}

async function applySet(
  sql: Sql,
  set: DatabaseMigrationSet,
  total: number,
  logger: LoggerService,
): Promise<MigrationSetSummary> {
  const before = await countAppliedMigrations(sql, set);
  if (before > 0) await assertNotOlderThanBaseline(sql, set);
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
  return { name: set.name, folder: set.folder, total, applied, online: { total: 0, applied: 0 } };
}

/**
 * The 55P03 error in `error`'s cause chain (drizzle wraps the driver's error in a
 * `DrizzleQueryError`), or `undefined` when the failure was something else.
 */
function lockTimeoutIn(error: unknown): Error | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth++) {
    if ((current as { code?: unknown }).code === LOCK_NOT_AVAILABLE) return current;
    current = current.cause;
  }
  return undefined;
}

/**
 * Applies one set, retrying it when a statement hit `lock_timeout`: drizzle has rolled the set's
 * transaction back (nothing recorded), so the retry, with exponential backoff and still under the
 * advisory lock, starts the set over. Any other failure, or the last 55P03, fails the run naming
 * the set; for a lock timeout the 55P03 error is the `cause`.
 */
async function applySetWithRetries(
  sql: Sql,
  set: DatabaseMigrationSet,
  total: number,
  lockWait: LockWaitPolicy,
  logger: LoggerService,
): Promise<MigrationSetSummary> {
  try {
    return await retry(() => applySet(sql, set, total, logger), {
      retries: lockWait.retries,
      minDelayMs: lockWait.retryDelayMs,
      maxDelayMs: Math.max(MAX_LOCK_WAIT_RETRY_DELAY_MS, lockWait.retryDelayMs),
      jitter: false, // one runner at a time (advisory lock): nothing to spread out
      shouldRetry: (error) => lockTimeoutIn(error) !== undefined,
      onRetry: (_error, attempt, delayMs) => {
        logger.warn(
          `${set.name}: lock_timeout (${lockWait.timeoutMs}ms) expired (${LOCK_NOT_AVAILABLE}); ` +
            `retry ${attempt} of ${lockWait.retries} in ${delayMs}ms: another transaction holds a ` +
            'lock this set needs (the set was rolled back)',
        );
      },
    });
  } catch (error) {
    const lockTimeout = lockTimeoutIn(error);
    if (lockTimeout === undefined) {
      throw new Error(`Migration set "${set.name}" (${set.folder}) failed`, { cause: error });
    }
    const attempts = lockWait.retries + 1;
    throw new Error(
      `Migration set "${set.name}" (${set.folder}) failed: lock_timeout (${lockWait.timeoutMs}ms) ` +
        `expired ${attempts === 1 ? 'on its only attempt' : `on all ${attempts} attempts`} ` +
        `(SQLSTATE ${LOCK_NOT_AVAILABLE}): another transaction kept a lock this set needs. Nothing ` +
        'of the set was applied; find the blocker (pg_stat_activity, pg_locks) or rerun once it ' +
        'ends (libs/database/README.md, "Lock waits")',
      { cause: lockTimeout },
    );
  }
}

const summarize = (sets: MigrationSetSummary[]): MigrationRunSummary => ({
  sets,
  total: sumBy(sets, 'total'),
  applied: sumBy(sets, 'applied'),
  online: {
    total: sumBy(sets, (set) => set.online.total),
    applied: sumBy(sets, (set) => set.online.applied),
  },
});

/** SQLSTATE protocol_violation: how PgBouncer refuses a startup parameter it does not ignore. */
const STARTUP_PARAMETER_REJECTED = '08P01';

/**
 * The first query on the new connection: is this Citus and, if so, the coordinator? A connect error
 * surfaces here (postgres.js connects lazily). PgBouncer refuses the session's `statement_timeout`
 * startup parameter with 08P01, which is how a `DATABASE_MIGRATION_URL` pointing at the pooler shows
 * up; it is rethrown naming the variable. The coordinator is the node that `citus_is_coordinator()`
 * names, or a node not yet in any cluster (`pg_dist_node` empty: a fresh single node, on which that
 * function is false until the first distributed table); a worker is refused, fail closed.
 */
async function inspectServer(sql: Sql): Promise<{ citus: boolean }> {
  let row: { citus: boolean } | undefined;
  try {
    [row] = await sql<{ citus: boolean }[]>`
      select exists (select 1 from pg_extension where extname = 'citus') as citus`;
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code !== STARTUP_PARAMETER_REJECTED) throw error;
    throw new Error(
      'DATABASE_MIGRATION_URL must connect directly to Postgres (the Citus coordinator), never ' +
        `through PgBouncer: the server refused the migration session at startup (${STARTUP_PARAMETER_REJECTED}: ${(error as Error).message})`,
      { cause: error },
    );
  }
  if (row?.citus !== true) return { citus: false };
  const [node] = await sql<{ coordinator: boolean }[]>`
    select citus_is_coordinator() or not exists (select 1 from pg_dist_node) as coordinator`;
  if (node?.coordinator !== true) {
    throw new Error(
      'The migration connection reached a node that is not the Citus coordinator ' +
        '(citus_is_coordinator() is false): DATABASE_MIGRATION_URL must point at the coordinator directly',
    );
  }
  return { citus: true };
}

/** Postgres time units, in ms, as a stored `lock_timeout` may carry them. */
const TIME_UNITS_MS: Readonly<Record<string, number>> = {
  us: 0.001,
  ms: 1,
  s: 1_000,
  min: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** A stored `lock_timeout` (`5000`, `5s`, `1min`…) in ms; `undefined` when unreadable. */
function parseLockTimeoutMs(value: string): number | undefined {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(us|ms|s|min|h|d)?\s*$/.exec(value);
  const unit = TIME_UNITS_MS[match?.[2] ?? 'ms'];
  if (match?.[1] === undefined || unit === undefined) return undefined;
  return Number(match[1]) * unit;
}

/**
 * On Citus the session's `lock_timeout` stays on the coordinator: the connections it opens to the
 * workers start from the role's default instead, so a lock held on a worker shard would still be
 * waited for without limit. Makes the connecting role's default (`ALTER ROLE CURRENT_USER SET`,
 * which Citus propagates to the workers) equal `timeoutMs`, only when it differs. Always run on a
 * throwaway connection, closed afterwards, because a session that ran the `ALTER ROLE` keeps the
 * worker connections it opened with the old value; and only under the advisory lock, because
 * another runner switches the same default for its online steps (`applyOnlineSteps`).
 */
async function alignRoleLockTimeout(
  sql: Sql,
  timeoutMs: number,
  logger: LoggerService,
): Promise<void> {
  const [row] = await sql<{ setconfig: string[] | null }[]>`
    select setconfig from pg_catalog.pg_db_role_setting
    where setdatabase = 0
      and setrole = (select oid from pg_catalog.pg_roles where rolname = current_user)`;
  const prefix = 'lock_timeout=';
  const current = row?.setconfig
    ?.filter((entry) => entry.startsWith(prefix))
    .at(-1)
    ?.slice(prefix.length);
  if (current !== undefined && parseLockTimeoutMs(current) === timeoutMs) return;
  // A utility statement takes no bind parameter; timeoutMs is a checked non-negative integer.
  await sql.unsafe(`alter role current_user set lock_timeout = ${timeoutMs}`);
  logger.log(
    `Citus: set the migration role's default lock_timeout to ${timeoutMs}ms ` +
      `(was ${current ?? 'unset'}) so worker connections inherit it`,
  );
}

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
 * directly, never through a transaction pooler. Called only on Citus (`inspectServer`).
 */
async function configureCitusSession(sql: Sql, logger: LoggerService): Promise<void> {
  await sql`set citus.enable_local_execution to on`;
  await sql`set citus.multi_shard_modify_mode to 'sequential'`;
  logger.log(
    'Citus detected: migration session uses local execution and sequential shard modification',
  );
}

/** The name Postgres stores for an identifier as written. */
const identifierName = (identifier: string): string =>
  identifier.startsWith('"')
    ? identifier.slice(1, -1).replaceAll('""', '"')
    : identifier.toLowerCase();

/**
 * Online steps go over the extended protocol: the server then refuses a file that holds several
 * statements (42601), where the simple protocol would run them as one implicit transaction, in
 * which `CREATE INDEX CONCURRENTLY` fails. (postgres.js picks the simple protocol for an `unsafe`
 * call without parameters unless told otherwise.)
 */
const EXTENDED_PROTOCOL = { prepare: false, simple: false };

/** Runs `fn` on a connection of its own, closed afterwards. */
async function onConnection<T>(open: () => Sql, fn: (sql: Sql) => Promise<T>): Promise<T> {
  const sql = open();
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** The set's online steps not yet recorded in `<schema>.__online_migrations` (all before it exists). */
async function pendingOnlineSteps(
  sql: Sql,
  set: DatabaseMigrationSet,
  steps: readonly OnlineStep[],
): Promise<OnlineStep[]> {
  if (steps.length === 0) return [];
  const [table] = await sql<{ exists: boolean }[]>`
    select to_regclass(format('%I.%I', ${set.migrationsSchema}::text, ${ONLINE_MIGRATIONS_TABLE}::text))
      is not null as exists`;
  if (table?.exists !== true) return [...steps];
  const rows = await sql<{ name: string }[]>`
    select name from ${sql(set.migrationsSchema)}.${sql(ONLINE_MIGRATIONS_TABLE)}`;
  const recorded = new Set(rows.map((row) => row.name));
  return steps.filter((step) => !recorded.has(step.name));
}

/**
 * A failed `CREATE INDEX CONCURRENTLY` leaves an INVALID index behind, which `IF NOT EXISTS` would
 * then skip: the file would be recorded without a usable index. So before a file runs, an invalid
 * index with the name ITS statement builds, on ITS table, is dropped (`DROP INDEX CONCURRENTLY`,
 * which Citus propagates to the shards). Only that one: an invalid index elsewhere may be another
 * session's build in progress. A statement that builds no index looks nothing up.
 */
async function dropInvalidIndexOf(
  online: Sql,
  set: DatabaseMigrationSet,
  step: OnlineStep,
  logger: LoggerService,
): Promise<void> {
  const [, index, table] = CREATE_INDEX_CONCURRENTLY.exec(withoutComments(step.statement)) ?? [];
  if (index === undefined || table === undefined) return;
  const [row] = await online<{ index: string }[]>`
    select format('%I.%I', n.nspname, c.relname) as index
    from pg_catalog.pg_index i
    join pg_catalog.pg_class c on c.oid = i.indexrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where i.indrelid = to_regclass(${table}) and c.relname = ${identifierName(index)}
      and not i.indisvalid`;
  if (row === undefined) return;
  logger.warn(
    `${set.name}: ${step.name} left the invalid index ${row.index} (an earlier run failed or was ` +
      'interrupted); dropping it before running the step again',
  );
  // A utility statement takes no bind parameter; the name comes back quoted by format('%I').
  await online.unsafe(`drop index concurrently if exists ${row.index}`);
}

/**
 * Runs `steps` in order on the online session, outside any transaction: each one after dropping
 * an invalid index it left before, and recorded only after it succeeded. A failure stops the run
 * naming the set and the file (the driver's error as `cause`); that file has no row, so the next
 * run retries it.
 */
async function runOnlineSteps(
  online: Sql,
  set: DatabaseMigrationSet,
  steps: readonly OnlineStep[],
  logger: LoggerService,
): Promise<void> {
  const [schema, table] = [online(set.migrationsSchema), online(ONLINE_MIGRATIONS_TABLE)];
  await online`
    create table if not exists ${schema}.${table} (
      name text primary key,
      applied_at timestamptz not null default now()
    )`;
  for (const step of steps) {
    try {
      await dropInvalidIndexOf(online, set, step, logger);
      await online.unsafe(step.statement, [], EXTENDED_PROTOCOL);
      await online`insert into ${schema}.${table} (name) values (${step.name}) on conflict do nothing`;
    } catch (error) {
      throw new Error(
        `Migration set "${set.name}": online step ${step.name} (${step.path}) failed; nothing was ` +
          'recorded for it, so the next run retries it (libs/database/README.md, "Online steps")',
        { cause: error },
      );
    }
    logger.log(`${set.name}: applied online step ${step.name}`);
  }
}

/** What the online steps of every set share within one run. */
interface OnlineRun {
  citus: boolean;
  /** The sets' `lock_timeout`, which the role default goes back to on Citus. */
  setTimeoutMs: number;
  onlineTimeoutMs: number;
  connect: (lockTimeoutMs: number, purpose: string) => Sql;
  logger: LoggerService;
}

/**
 * Runs the set's pending online steps (if any) on a second session, opened while `sql` keeps the
 * advisory lock, with the online `lock_timeout`. On Citus the shard connections start from the
 * role's default instead, so a throwaway connection first sets it to the online value, and another
 * one sets it back to the sets' value once the online session closed (whatever happened; a run that
 * crashed in between leaves the online value, which the next run's alignment under the lock
 * repairs). Throwaway connections, so neither session caches a shard connection opened with the
 * other value. Nothing pending: no session.
 */
async function applyOnlineSteps(
  sql: Sql,
  set: DatabaseMigrationSet,
  steps: readonly OnlineStep[],
  run: OnlineRun,
): Promise<OnlineStepsSummary> {
  const pending = await pendingOnlineSteps(sql, set, steps);
  if (pending.length === 0) return { total: steps.length, applied: 0 };
  const { logger } = run;
  const switchRole = run.citus && run.onlineTimeoutMs !== run.setTimeoutMs;
  const setRoleDefault = (timeoutMs: number): Promise<void> =>
    onConnection(
      () => run.connect(run.setTimeoutMs, 'migrate'),
      (conn) => alignRoleLockTimeout(conn, timeoutMs, logger),
    );
  if (switchRole) await setRoleDefault(run.onlineTimeoutMs);
  let failed = true;
  try {
    await onConnection(
      () => run.connect(run.onlineTimeoutMs, 'migrate-online'),
      (online) => runOnlineSteps(online, set, pending, logger),
    );
    failed = false;
  } finally {
    if (switchRole) {
      await setRoleDefault(run.setTimeoutMs).catch((error: unknown) => {
        if (!failed) throw error;
        // Keep the step's error; the next run's alignment restores the default.
        logger.error(
          `Could not set the migration role's default lock_timeout back to ${run.setTimeoutMs}ms ` +
            `after a failed online step: ${String(error)}`,
        );
      });
    }
  }
  return { total: steps.length, applied: pending.length };
}

/**
 * Applies the pending drizzle-kit migrations of several sets, in order, safely under concurrency:
 * - the sets must start with the platform set, each with its own bookkeeping table and journal
 *   (`assertMigrationSets`): checked before connecting, whoever calls;
 * - it must reach Postgres directly: on Citus the coordinator (a worker is refused), never PgBouncer
 *   (the 08P01 startup refusal is rethrown naming `DATABASE_MIGRATION_URL`);
 * - ONE advisory lock around every set, so different services sharing a database migrate one
 *   after the other;
 * - a dedicated `max: 1` client so the session-level lock and every `migrate()` share ONE
 *   connection (`max_lifetime: null` — a recycled socket would silently drop the lock);
 * - `statement_timeout: '0'` for this session only: DDL / backfills may legitimately run long. A
 *   string, because postgres.js leaves falsy values out of the startup message; sent, it is also
 *   what PgBouncer refuses (08P01) when the URL points at the pooler;
 * - `lock_timeout` (`lockWaitTimeoutMs`, default 5 s; a string too, so 0 is sent): an `ALTER` that
 *   meets an open transaction gives up instead of queueing every query on its table behind it. On
 *   Citus a preliminary connection first checks for the coordinator, then closes; once the
 *   migration session holds the advisory lock, and before its first statement that reaches a
 *   worker, a throwaway connection makes the role's default `lock_timeout` the same
 *   (`alignRoleLockTimeout`), so the worker connections the session opens later start with it.
 *   Under the lock, so a runner that waits never undoes another's online window, and the value a
 *   crashed run's online window left is repaired before any set;
 * - a set that fails with 55P03 (lock timeout) was rolled back whole; it is retried with backoff
 *   (`lockWaitRetries`, default 5) under the same advisory lock, then fails the run naming the set
 *   and the timeout, with the 55P03 error as `cause`;
 * - on Citus (the `citus` extension is installed), `citus.enable_local_execution = on` and
 *   `citus.multi_shard_modify_mode = 'sequential'` for this session, so a set can create a schema
 *   or enum, distribute tables and add their foreign keys in one transaction;
 * - each set writes its own bookkeeping table: drizzle applies only files newer than the LAST row
 *   of that table, so a shared table would skip the files of the set with older timestamps;
 * - drizzle runs a set's pending migrations in one transaction (all-or-nothing per set); a set
 *   that already ran stays applied when a later set fails;
 * - a set's online steps (`onlineFolder`: `CREATE INDEX CONCURRENTLY`, `VALIDATE CONSTRAINT`, one
 *   statement per file) run after its transactional files, still under the advisory lock, on a
 *   second session with `onlineLockTimeoutMs` (default 0, wait: a lock timeout would cancel a
 *   concurrent build), each recorded in `<schema>.__online_migrations` once it succeeded
 *   (`applyOnlineSteps`); a failing one stops the run naming it, unrecorded;
 * - a failing set stops the run (the sets after it are not attempted) with an error that names it
 *   and carries the driver's error as `cause`.
 *
 * Every journal is read before connecting: a missing one, or a malformed one (an entry without a
 * string `tag`, a positive integer `when` or a boolean `breakpoints`, or a `when` that does not
 * grow) fails the run up front, naming the set or the entry. So is every online folder
 * (`readOnlineSteps`).
 */
export async function runMigrations(
  url: string,
  options: RunMigrationsOptions,
): Promise<MigrationRunSummary> {
  const logger = options.logger ?? new Logger('DatabaseMigrations');
  assertMigrationSets(options.migrations);
  const plan = options.migrations.map((set) => ({
    set,
    total: readJournalSize(set),
    onlineSteps: readOnlineSteps(set),
  }));
  const lockWait: LockWaitPolicy = {
    timeoutMs: options.lockWaitTimeoutMs ?? DEFAULT_LOCK_WAIT_TIMEOUT_MS,
    retries: options.lockWaitRetries ?? DEFAULT_LOCK_WAIT_RETRIES,
    retryDelayMs: options.lockWaitRetryDelayMs ?? DEFAULT_LOCK_WAIT_RETRY_DELAY_MS,
  };
  for (const [name, value] of Object.entries(lockWait)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`runMigrations: lock wait ${name} must be a non-negative integer (${value})`);
    }
  }
  const onlineTimeoutMs = options.onlineLockTimeoutMs ?? 0;
  if (!Number.isSafeInteger(onlineTimeoutMs) || onlineTimeoutMs < 0) {
    throw new Error(
      `runMigrations: onlineLockTimeoutMs must be a non-negative integer (${onlineTimeoutMs})`,
    );
  }

  const connect = (lockTimeoutMs = lockWait.timeoutMs, purpose = 'migrate'): Sql =>
    postgres(url, {
      max: 1,
      max_lifetime: null,
      prepare: false,
      onnotice: (notice) => {
        logger.debug?.(notice['message'] ?? 'notice');
      },
      connection: {
        application_name: `${options.applicationName ?? 'app'}:${purpose}`,
        // Strings: postgres.js drops falsy startup values, so a number 0 would never be sent.
        statement_timeout: '0' as unknown as number,
        lock_timeout: String(lockTimeoutMs) as unknown as number,
      },
    });
  // On plain Postgres the first connection is the migration session; on Citus it is the
  // preliminary one (coordinator and PgBouncer check), closed before the session opens.
  let sql = connect();
  let locked = false;
  try {
    const { citus } = await inspectServer(sql);
    if (citus) {
      await sql.end({ timeout: 5 });
      sql = connect();
    }
    await acquireMigrationLock(
      sql,
      options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
      options.lockPollIntervalMs ?? DEFAULT_LOCK_POLL_INTERVAL_MS,
      logger,
    );
    locked = true;
    if (citus) {
      // Under the lock: another runner's online window may have the default at its online value
      // (or a crashed one left it there). The session has opened no worker connection yet (it has
      // only taken the lock, which stays on the coordinator), so the ones it opens start aligned.
      await onConnection(
        () => connect(),
        (conn) => alignRoleLockTimeout(conn, lockWait.timeoutMs, logger),
      );
      await configureCitusSession(sql, logger);
    }
    const onlineRun: OnlineRun = {
      citus,
      setTimeoutMs: lockWait.timeoutMs,
      onlineTimeoutMs,
      connect,
      logger,
    };
    const results: MigrationSetSummary[] = [];
    for (const { set, total, onlineSteps } of plan) {
      const applied = await applySetWithRetries(sql, set, total, lockWait, logger);
      const online = await applyOnlineSteps(sql, set, onlineSteps, onlineRun);
      results.push({ ...applied, online });
    }
    return summarize(results);
  } finally {
    if (locked) await sql`select pg_advisory_unlock(${MIGRATIONS_ADVISORY_LOCK_ID})`.catch(noop);
    await sql.end({ timeout: 5 });
  }
}

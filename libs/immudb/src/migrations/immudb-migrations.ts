import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { type ImmudbConfig, immudbConfig } from '@platform/config';
import { createImmudbGrpcClient } from '../client/create-immudb-grpc-client.js';
import { ImmudbSession } from '../client/immudb-session.js';
import { toImmudbError } from '../errors/immudb.error.js';
import { type ImmuServiceClient, TxMode } from '../generated/immudb/schema/schema.pb.js';
import type { ImmudbMigrationSource } from '../immudb.types.js';

export const IMMUDB_MIGRATIONS_TABLE = 'immudb_migrations';
/** Taken from the application user: it may only SELECT and INSERT (append-only by privilege). */
export const IMMUDB_REVOKED_PRIVILEGES = ['UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE'] as const;
/** immudb's system database: provisioning sessions open here. */
const SYSTEM_DATABASE = 'defaultdb';
const FILE_NAME = /^(\d{3})_[a-z0-9_]+\.sql$/;
const IDEMPOTENT = /^CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)\s+IF\s+NOT\s+EXISTS\b/i;

export interface ImmudbMigrationFile {
  readonly id: string;
  readonly sql: string;
  readonly statements: readonly string[];
  readonly checksum: string;
}

export interface ImmudbMigrationSummary {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
}

export interface RunImmudbMigrationsOptions {
  readonly grpc?: ImmuServiceClient;
  readonly logger?: Pick<Logger, 'log'>;
  readonly now?: () => Date;
}

async function mapped<T>(call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (error) {
    throw toImmudbError(error) ?? error;
  }
}

/** Statements of a migration file (`;`-separated, `--` comments; no string literals with `;`). */
export function splitImmudbSql(sql: string): string[] {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map((statement) => statement.replace(/\s+/g, ' ').trim())
    .filter((statement) => statement.length > 0);
}

export async function loadImmudbMigrations(
  sources: readonly ImmudbMigrationSource[],
): Promise<ImmudbMigrationFile[]> {
  const names = new Set<string>();
  const files: ImmudbMigrationFile[] = [];
  for (const source of sources) {
    if (names.has(source.name)) {
      throw new Error(`immudb migration source "${source.name}" is listed twice`);
    }
    names.add(source.name);
    const versions = new Set<string>();
    const entries = (await readdir(source.dir)).filter((file) => file.endsWith('.sql')).sort();
    for (const file of entries) {
      const version = FILE_NAME.exec(file)?.[1];
      if (version === undefined) throw new Error(`${source.name}/${file}: expected NNN_name.sql`);
      if (versions.has(version)) {
        throw new Error(`${source.name}: version ${version} is used twice`);
      }
      versions.add(version);
      const sql = await readFile(join(source.dir, file), 'utf8');
      const statements = splitImmudbSql(sql);
      const unsafe = statements.find((statement) => !IDEMPOTENT.test(statement));
      if (unsafe !== undefined) {
        throw new Error(
          `${source.name}/${file}: only CREATE TABLE|INDEX ... IF NOT EXISTS statements are allowed (got "${unsafe.slice(0, 60)}")`,
        );
      }
      files.push({
        id: `${source.name}/${file}`,
        sql,
        statements,
        checksum: createHash('sha256').update(sql).digest('hex'),
      });
    }
  }
  return files;
}

/** The object exists already, or a runner booting at the same time just created it (MVCC loser). */
function createdElsewhere(error: unknown): boolean {
  if (error instanceof Error && /already exists/.test(error.message)) return true;
  return toImmudbError(error)?.kind === 'read-conflict';
}

/** Runs an idempotent statement; a concurrent runner's catalog change surfaces as a read conflict. */
async function execIdempotent(session: ImmudbSession, sql: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await mapped(session.exec(sql));
      return;
    } catch (error) {
      if (toImmudbError(error)?.kind !== 'read-conflict' || attempt >= 5) throw error;
    }
  }
}

/** Database, application user (read-write), then its SQL privileges narrowed to SELECT + INSERT. */
async function provision(
  system: ImmudbSession,
  target: { database: string; username: string; password: string },
): Promise<void> {
  try {
    await system.createDatabase(target.database);
  } catch (error) {
    if (!createdElsewhere(error)) throw toImmudbError(error) ?? error;
  }
  try {
    await system.createUser(target.username, target.password, target.database);
  } catch (error) {
    // An existing user keeps its password (rotate with immuadmin) but may have been created for
    // another database: give it read-write on this one (the probe in L-3 showed the server refuses
    // ChangeSQLPrivileges for a user without a permission on the database).
    if (!createdElsewhere(error)) throw toImmudbError(error) ?? error;
    await mapped(system.grantReadWrite(target.username, target.database));
  }
  // Re-applied on every run, so a run that died after CreateUser never leaves a read-write user.
  // The server then ends that user's open sessions (pkg/server/user.go ChangeSQLPrivileges): pools
  // recover through the "no session found" retry, but in production run migrations from one
  // process (the migrate step), not from every replica at boot.
  await mapped(
    system.revokeSqlPrivileges(target.username, target.database, IMMUDB_REVOKED_PRIVILEGES),
  );
}

type RecordedRow = { id: string; checksum: string };

async function recorded(session: ImmudbSession): Promise<Map<string, string>> {
  const tx = await mapped(session.newTx(TxMode.ReadOnly));
  try {
    const rows = (await mapped(
      session.txQuery(tx, `SELECT id, checksum FROM ${IMMUDB_MIGRATIONS_TABLE}`),
    )) as RecordedRow[];
    return new Map(rows.map((row) => [row.id, row.checksum]));
  } finally {
    await session.rollback(tx).catch(() => undefined);
  }
}

function assertUnchanged(file: ImmudbMigrationFile, checksum: string): void {
  if (checksum !== file.checksum) {
    throw new Error(`immudb migration ${file.id} changed after it was applied (never edit one)`);
  }
}

/** Records `file` as applied; `false` when another runner recorded it first. */
async function record(
  session: ImmudbSession,
  file: ImmudbMigrationFile,
  at: Date,
): Promise<boolean> {
  const tx = await mapped(session.newTx(TxMode.ReadWrite));
  try {
    const [existing] = (await mapped(
      session.txQuery(tx, `SELECT id, checksum FROM ${IMMUDB_MIGRATIONS_TABLE} WHERE id = @id`, {
        id: file.id,
      }),
    )) as RecordedRow[];
    if (existing !== undefined) {
      assertUnchanged(file, existing.checksum);
      await session.rollback(tx);
      return false;
    }
    await mapped(
      session.txExec(
        tx,
        `INSERT INTO ${IMMUDB_MIGRATIONS_TABLE} (id, checksum, applied_at_us) VALUES (@id, @checksum, @at)`,
        { id: file.id, checksum: file.checksum, at: BigInt(at.getTime()) * 1_000n },
      ),
    );
    await mapped(session.commit(tx));
    return true;
  } catch (error) {
    const kind = toImmudbError(error)?.kind;
    if (kind !== 'duplicate-key' && kind !== 'read-conflict') throw error;
    // A concurrent runner recorded it first (the server already ended this tx).
    const checksum = (await recorded(session)).get(file.id);
    if (checksum === undefined) throw error;
    assertUnchanged(file, checksum);
    return false;
  }
}

/**
 * Provisions `cfg.database` and the INSERT/SELECT-only `cfg.credentials` user (as `cfg.admin` on
 * `defaultdb`), then applies every pending file of `sources` in order as admin on `cfg.database`.
 * Idempotent and safe to run from several replicas at once.
 */
export async function runImmudbMigrations(
  cfg: ImmudbConfig,
  sources: readonly ImmudbMigrationSource[],
  options: RunImmudbMigrationsOptions = {},
): Promise<ImmudbMigrationSummary> {
  const admin = cfg.admin;
  if (admin === undefined) {
    throw new Error('IMMUDB_ADMIN_PASSWORD is required to provision and migrate immudb');
  }
  const files = await loadImmudbMigrations(sources);
  const logger = options.logger ?? new Logger('ImmudbMigrations');
  const now = options.now ?? (() => new Date());
  const grpc = options.grpc ?? createImmudbGrpcClient(cfg);
  try {
    const system = await mapped(
      ImmudbSession.open(grpc, { ...admin, database: SYSTEM_DATABASE }, cfg.timeoutMs),
    );
    try {
      await provision(system, { database: cfg.database, ...cfg.credentials });
    } finally {
      await system.close().catch(() => undefined);
    }
    const session = await mapped(
      ImmudbSession.open(grpc, { ...admin, database: cfg.database }, cfg.timeoutMs),
    );
    try {
      await execIdempotent(
        session,
        `CREATE TABLE IF NOT EXISTS ${IMMUDB_MIGRATIONS_TABLE} (id VARCHAR[160], checksum VARCHAR[64], applied_at_us INTEGER, PRIMARY KEY id)`,
      );
      const done = await recorded(session);
      const applied: string[] = [];
      const skipped: string[] = [];
      for (const file of files) {
        const checksum = done.get(file.id);
        if (checksum !== undefined) {
          assertUnchanged(file, checksum);
          skipped.push(file.id);
          continue;
        }
        for (const statement of file.statements) await execIdempotent(session, statement);
        if (await record(session, file, now())) {
          applied.push(file.id);
          logger.log(`applied immudb migration ${file.id}`);
        } else {
          skipped.push(file.id);
        }
      }
      return { applied, skipped };
    } finally {
      await session.close().catch(() => undefined);
    }
  } finally {
    if (options.grpc === undefined) grpc.close();
  }
}

/** `src/migrate.ts` entry: `await runImmudbMigrationsCli([billingLedgerMigrations]);` */
export async function runImmudbMigrationsCli(
  sources: readonly ImmudbMigrationSource[],
): Promise<void> {
  const logger = new Logger('ImmudbMigrations');
  const summary = await runImmudbMigrations(immudbConfig.parse(), sources, { logger });
  logger.log(
    `immudb migrations: ${summary.applied.length} applied, ${summary.skipped.length} already applied`,
  );
}

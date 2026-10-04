import { readdirSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, join } from 'node:path';
import { sha256Hex, sleep } from '@app/common';
import { Logger, type LoggerService } from '@nestjs/common';
import cassandra from 'cassandra-driver';
import { countBy, flatMap, keyBy, orderBy, pickBy } from 'lodash-es';
import type { CassandraClient, CassandraMigrationSource } from '../cassandra.types.js';
import { assertCqlIdentifier } from '../client/client-options.js';
import { splitCqlStatements } from './cql-script.js';

const { consistencies } = cassandra.types;

/** `001_create_notifications.cql` → sequence 1, version `001_create_notifications`. */
const MIGRATION_FILE = /^(\d+)_([A-Za-z0-9][\w-]*)\.cql$/;
/** Placeholder replaced by the keyspace, for fully-qualified statements (`{keyspace}.table`). */
const KEYSPACE_PLACEHOLDER = '{keyspace}';

/** Bookkeeping table (`<keyspace>.schema_migrations`), one row per applied `.cql` file. */
export const CQL_MIGRATIONS_TABLE = 'schema_migrations';

export interface CqlMigration {
  /** Unique id recorded in `<ks>.schema_migrations`: the file name without `.cql`. */
  version: string;
  sequence: number;
  file: string;
  statements: string[];
  /** sha256 of the normalized statements — comment/whitespace edits don't change it. */
  checksum: string;
}

export interface CqlMigratorOptions {
  keyspace: string;
  sources: readonly CassandraMigrationSource[];
  logger?: LoggerService;
  /** Max wait while another instance holds a migration's claim. Default 2 min. */
  lockTimeoutMs?: number;
  /** Poll interval while waiting for another instance. Default 1 s. */
  pollIntervalMs?: number;
  /** Recorded as `claimed_by` (ops: who holds a stuck claim). Default `hostname:pid`. */
  instanceId?: string;
}

export interface CqlMigrationSummary {
  total: number;
  /** Versions applied by THIS instance. */
  applied: string[];
}

/**
 * Formatting-insensitive form of a statement. The checksum only drives the "edited after apply"
 * warning, so reformatting (re-indenting, spaces around parentheses) must not trigger it.
 */
const normalizeForChecksum = (statement: string): string =>
  statement.replace(/\s+/g, ' ').replace(/\s*([(),;=<>{}[\]])\s*/g, '$1');

const Status = { APPLYING: 'applying', APPLIED: 'applied' } as const;
type Status = (typeof Status)[keyof typeof Status];

/**
 * Reads every `NNN_name.cql` of the sources (in source order; numeric order within a folder).
 * Fails fast on misnamed `.cql` files, duplicate sequence numbers in a folder and duplicate
 * versions across folders — ambiguity there means silently skipped or reordered DDL.
 */
export function loadCqlMigrations(sources: readonly CassandraMigrationSource[]): CqlMigration[] {
  const migrations = flatMap(sources, ({ dir }) => {
    const files = readdirSync(dir).filter((name) => name.endsWith('.cql'));
    const parsed = files.map((name) => {
      const match = MIGRATION_FILE.exec(name);
      if (match?.[1] === undefined) {
        throw new Error(
          `Invalid CQL migration file name "${name}" in ${dir} (expected NNN_name.cql)`,
        );
      }
      const file = join(dir, name);
      const statements = splitCqlStatements(readFileSync(file, 'utf8'));
      if (statements.length === 0) throw new Error(`CQL migration ${file} contains no statements`);
      return {
        version: basename(name, '.cql'),
        sequence: Number.parseInt(match[1], 10),
        file,
        statements,
        checksum: sha256Hex(statements.map(normalizeForChecksum).join(';\n')),
      } satisfies CqlMigration;
    });
    const clashes = pickBy(
      countBy(parsed, (m) => m.sequence),
      (count) => count > 1,
    );
    if (Object.keys(clashes).length > 0) {
      throw new Error(
        `Duplicate CQL migration numbers in ${dir}: ${Object.keys(clashes).join(', ')}`,
      );
    }
    return orderBy(parsed, ['sequence', 'version']);
  });
  const duplicates = pickBy(
    countBy(migrations, (m) => m.version),
    (count) => count > 1,
  );
  if (Object.keys(duplicates).length > 0) {
    throw new Error(`Duplicate CQL migration versions: ${Object.keys(duplicates).join(', ')}`);
  }
  return migrations;
}

/**
 * Forward-only CQL migration runner, safe with many replicas booting at once:
 * 1. one `SELECT` of `<ks>.schema_migrations` → already-applied versions cost no LWT;
 * 2. each pending version is CLAIMED with `INSERT … IF NOT EXISTS` (Paxos). The winner applies
 *    it and flips `status` to `applied`; losers poll (the failed LWT returns the current row)
 *    until it is applied, so no replica serves traffic before the schema exists;
 * 3. a failed migration releases its claim (`DELETE … IF EXISTS`) and rethrows — statements must
 *    therefore be idempotent (`IF NOT EXISTS` / `IF EXISTS`) so a retry can re-run them.
 * DDL waits for schema agreement automatically (`maxSchemaAgreementWaitSeconds`).
 */
export class CqlMigrator {
  private readonly keyspace: string;
  private readonly table: string;
  private readonly logger: LoggerService;
  private readonly lockTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly instanceId: string;

  constructor(
    private readonly client: CassandraClient,
    private readonly options: CqlMigratorOptions,
  ) {
    assertCqlIdentifier(options.keyspace, 'keyspace');
    this.keyspace = options.keyspace;
    this.table = `${options.keyspace}.${CQL_MIGRATIONS_TABLE}`;
    this.logger = options.logger ?? new Logger(CqlMigrator.name);
    this.lockTimeoutMs = options.lockTimeoutMs ?? 120_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.instanceId = options.instanceId ?? `${hostname()}:${process.pid}`;
  }

  async run(): Promise<CqlMigrationSummary> {
    const migrations = loadCqlMigrations(this.options.sources); // before touching the cluster
    if (migrations.length === 0) return { total: 0, applied: [] };

    await this.client.execute(
      `CREATE TABLE IF NOT EXISTS ${this.table} (version text PRIMARY KEY, checksum text, status text, claimed_by text, claimed_at timestamp, applied_at timestamp)`,
      [],
      { prepare: false },
    );
    const known = await this.readStates();
    const applied: string[] = [];
    for (const migration of migrations) {
      const state = known[migration.version];
      if (state?.status === Status.APPLIED) {
        this.warnOnChecksumDrift(migration, state.checksum);
        continue;
      }
      if (await this.ensureApplied(migration)) applied.push(migration.version);
    }
    this.logger.log(
      applied.length > 0
        ? `Applied CQL migrations: ${applied.join(', ')}`
        : `Cassandra keyspace "${this.keyspace}" is up to date (${migrations.length} migrations)`,
    );
    return { total: migrations.length, applied };
  }

  private async readStates(): Promise<Record<string, { status: string; checksum: string }>> {
    const rs = await this.client.execute(
      `SELECT version, status, checksum FROM ${this.table}`,
      [],
      { prepare: true, consistency: consistencies.localQuorum, fetchSize: 1_000 },
    );
    const states = rs.rows.map((row) => ({
      version: String(row.get('version')),
      status: String(row.get('status')),
      checksum: String(row.get('checksum')),
    }));
    return keyBy(states, 'version');
  }

  /** Claims + applies, or waits for the instance holding the claim. `true` = applied by us. */
  private async ensureApplied(migration: CqlMigration): Promise<boolean> {
    const deadline = Date.now() + this.lockTimeoutMs;
    for (let attempt = 1; ; attempt++) {
      const claim = await this.client.execute(
        `INSERT INTO ${this.table} (version, checksum, status, claimed_by, claimed_at) VALUES (?, ?, ?, ?, toTimestamp(now())) IF NOT EXISTS`,
        [migration.version, migration.checksum, Status.APPLYING, this.instanceId],
        { prepare: true },
      );
      if (claim.wasApplied()) {
        await this.apply(migration);
        return true;
      }
      // A failed LWT returns the row that blocked it (linearizable read, no extra query).
      const current = claim.rows[0];
      const status = current?.get('status') as Status | null | undefined;
      if (status === Status.APPLIED) return false;
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out after ${this.lockTimeoutMs}ms waiting for CQL migration ${migration.version} ` +
            `(claimed by ${String(current?.get('claimed_by'))}). If that instance died, release it: ` +
            `DELETE FROM ${this.table} WHERE version = '${migration.version}';`,
        );
      }
      if (attempt === 1) {
        this.logger.log(`CQL migration ${migration.version} is being applied elsewhere — waiting`);
      }
      await sleep(this.pollIntervalMs);
    }
  }

  private async apply(migration: CqlMigration): Promise<void> {
    try {
      for (const statement of migration.statements) {
        // DDL is never prepared (pointless, and it would pollute the prepared-statement cache).
        await this.client.execute(statement.replaceAll(KEYSPACE_PLACEHOLDER, this.keyspace), [], {
          prepare: false,
        });
      }
      const done = await this.client.execute(
        `UPDATE ${this.table} SET status = ?, applied_at = toTimestamp(now()) WHERE version = ? IF status = ?`,
        [Status.APPLIED, migration.version, Status.APPLYING],
        { prepare: true },
      );
      if (!done.wasApplied()) {
        this.logger.warn(`CQL migration ${migration.version}: claim row changed while applying`);
      }
    } catch (error) {
      await this.client
        .execute(`DELETE FROM ${this.table} WHERE version = ? IF EXISTS`, [migration.version], {
          prepare: true,
        })
        .catch((releaseError: unknown) => {
          this.logger.error(
            `Could not release the claim of ${migration.version}: ${String(releaseError)}`,
          );
        });
      throw new Error(`CQL migration ${migration.version} failed (${migration.file})`, {
        cause: error,
      });
    }
  }

  private warnOnChecksumDrift(migration: CqlMigration, recorded: string): void {
    if (recorded !== migration.checksum) {
      this.logger.warn(
        `CQL migration ${migration.version} changed after it was applied — ` +
          'edits to applied migrations are NOT re-run; add a new migration instead',
      );
    }
  }
}

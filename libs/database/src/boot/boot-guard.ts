import type { DatabaseConfig } from '@platform/config';
import type { DatabaseMigrationSet } from '../database.types.js';
import { platformMigrations } from '../platform/platform.migrations.js';

/**
 * The `DatabaseModule` boot guard (program spec §4, B3-14; sharding design §7.3, SH-10). After both
 * pools are open and before the module resolves, it asks the live connections what they are:
 *
 * - runtime connection: not a superuser; no BYPASSRLS; owns no relation in the migration sets'
 *   schemas, directly or through a role it is a member of; every table there has RLS enabled AND
 *   forced, except the internal tables below; no privilege on an internal table; on Citus,
 *   `citus.propagate_set_commands = 'local'` (without it the RLS context never reaches a shard);
 * - system connection, when configured: not a superuser; has BYPASSRLS; owns no relation there; the
 *   same Citus setting; another user than the runtime connection.
 *
 * Internal tables carry no RLS and are granted to no app role: each set's bookkeeping table and the
 * platform set's colocation anchor `app.tenant_colocation` (0001; always empty, never queried).
 *
 * Fail closed: a check whose statement errors, or answers in another shape than expected, is a
 * finding like any other. Each check is one catalog statement with bound parameters only (schema
 * and table names are never spliced into SQL text), with no session state, so it also runs behind
 * PgBouncer in transaction mode.
 */

export type BootGuardMode = DatabaseConfig['bootGuard'];

export interface BootGuardFinding {
  /** `<runtime|system>.<requirement>`, e.g. `runtime.rls-forced`. */
  readonly check: string;
  /** What was found; names roles, schemas and tables, never a URL. */
  readonly detail: string;
}

/** Thrown in `enforce` mode with every finding; `DatabaseModule` ends both pools first. */
export class DatabaseBootGuardError extends Error {
  readonly findings: readonly BootGuardFinding[];

  constructor(findings: readonly BootGuardFinding[]) {
    super(
      `Database boot guard refused to start (${findings.length} ${findings.length === 1 ? 'finding' : 'findings'}): ` +
        findings.map((finding) => `${finding.check}: ${finding.detail}`).join('; '),
    );
    this.name = 'DatabaseBootGuardError';
    this.findings = Object.freeze([...findings]);
  }
}

/** What the guard needs of a pool: postgres.js `unsafe(text, params)` (a `Sql` satisfies it). */
export interface BootGuardClient {
  unsafe(query: string, parameters?: string[][]): PromiseLike<readonly unknown[]>;
}

export interface BootGuardTarget {
  readonly runtime: BootGuardClient;
  /** `null` without DATABASE_SYSTEM_URL: the system checks are skipped. */
  readonly system: BootGuardClient | null;
  /** Every set this process migrates, the platform set included (`withPlatformMigrations`). */
  readonly sets: readonly DatabaseMigrationSet[];
}

export interface BootGuardLogger {
  log(message: string): void;
  warn(message: string): void;
}

/** The platform set's colocation anchor (0001_citus_helpers): no RLS, granted to no app role. */
const TENANT_COLOCATION_TABLE = 'tenant_colocation';

/** Relation kinds that "own a table" covers: tables, partitioned tables, views, foreign tables. */
const OWNED_RELATION_KINDS = `('r', 'p', 'v', 'm', 'f')`;

const SUPERUSER_SQL = `select r.rolsuper as flag from pg_catalog.pg_roles r where r.rolname = current_user`;
const BYPASSRLS_SQL = `select r.rolbypassrls as flag from pg_catalog.pg_roles r where r.rolname = current_user`;
const CURRENT_USER_SQL = 'select current_user::text as name';
/** $1 = schemas. */
const OWNED_SQL = `
  select format('%I.%I', n.nspname, c.relname) as name
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = any($1::text[])
     and c.relkind in ${OWNED_RELATION_KINDS}
     and pg_catalog.pg_has_role(current_user, c.relowner, 'MEMBER')
   order by 1`;
/** $1 = schemas, $2/$3 = internal tables (schema, table). */
const RLS_SQL = `
  select format('%I.%I', n.nspname, c.relname) as name
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = any($1::text[])
     and c.relkind in ('r', 'p')
     and not (c.relrowsecurity and c.relforcerowsecurity)
     and not exists (
       select 1 from unnest($2::text[], $3::text[]) as i(schema_name, table_name)
        where i.schema_name = n.nspname and i.table_name = c.relname)
   order by 1`;
/** $1/$2 = internal tables (schema, table). */
const INTERNAL_PRIVILEGE_SQL = `
  select format('%I.%I', n.nspname, c.relname) as name
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join unnest($1::text[], $2::text[]) as i(schema_name, table_name)
      on i.schema_name = n.nspname and i.table_name = c.relname
   where pg_catalog.has_table_privilege(c.oid,
           'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
      or pg_catalog.has_any_column_privilege(c.oid, 'SELECT, INSERT, UPDATE, REFERENCES')
   order by 1`;
const CITUS_SQL = `select app.citus_enabled() as citus, current_setting('citus.propagate_set_commands', true) as setting`;

/** An answer that is not the shape a check expects (fail closed). */
class UnexpectedAnswer extends Error {}

type Row = Record<string, unknown>;

const singleRow = (rows: readonly unknown[]): Row => {
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new UnexpectedAnswer(`expected one row, got ${describeRows(rows)}`);
  }
  const [row] = rows as unknown[];
  if (typeof row !== 'object' || row === null) throw new UnexpectedAnswer('row is not an object');
  return row as Row;
};

const flagOf = (rows: readonly unknown[]): boolean => {
  const { flag } = singleRow(rows);
  if (typeof flag !== 'boolean') throw new UnexpectedAnswer(`flag is ${typeof flag}`);
  return flag;
};

const namesOf = (rows: readonly unknown[]): string[] => {
  if (!Array.isArray(rows)) throw new UnexpectedAnswer(`expected rows, got ${describeRows(rows)}`);
  return (rows as unknown[]).map((row) => {
    const name = typeof row === 'object' && row !== null ? (row as Row)['name'] : undefined;
    if (typeof name !== 'string' || name === '') {
      throw new UnexpectedAnswer('a row without a non-empty text name');
    }
    return name;
  });
};

const userOf = (rows: readonly unknown[]): string => {
  const [name] = namesOf(rows);
  if (rows.length !== 1 || name === undefined) {
    throw new UnexpectedAnswer(`expected one row, got ${describeRows(rows)}`);
  }
  return name;
};

const propagateSettingOf = (
  rows: readonly unknown[],
): { citus: boolean; setting: string | null } => {
  const { citus, setting } = singleRow(rows);
  if (typeof citus !== 'boolean') throw new UnexpectedAnswer(`citus is ${typeof citus}`);
  if (setting !== null && typeof setting !== 'string') {
    throw new UnexpectedAnswer(`setting is ${typeof setting}`);
  }
  return { citus, setting };
};

const describeRows = (rows: unknown): string =>
  Array.isArray(rows) ? `${rows.length} rows` : typeof rows;

/** What one check concluded: `null` = satisfied, a string = the finding's detail. */
type Verdict = string | null;

/** Runs one check; an erroring statement or an unexpected answer becomes the finding. */
async function check(
  findings: BootGuardFinding[],
  name: string,
  evaluate: () => Promise<Verdict>,
): Promise<void> {
  let detail: Verdict;
  try {
    detail = await evaluate();
  } catch (error) {
    detail =
      error instanceof UnexpectedAnswer
        ? `unexpected answer (${error.message}); the check cannot pass`
        : `query failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (detail !== null) findings.push({ check: name, detail });
}

const query = async (
  client: BootGuardClient,
  text: string,
  parameters?: string[][],
): Promise<readonly unknown[]> =>
  parameters === undefined ? client.unsafe(text) : client.unsafe(text, parameters);

const list = (names: readonly string[]): string => names.join(', ');

const citusVerdict = (who: string, answer: { citus: boolean; setting: string | null }): Verdict => {
  if (!answer.citus || answer.setting === 'local') return null;
  const value = answer.setting === null ? 'not set' : `'${answer.setting}'`;
  return `Citus is installed but citus.propagate_set_commands is ${value} for the ${who} connection; it must be 'local' (ALTER ROLE … SET citus.propagate_set_commands = 'local'), or the RLS context never reaches a shard`;
};

/** The schemas and internal tables of `sets`, as bound parameters. */
function scopeOf(sets: readonly DatabaseMigrationSet[]) {
  const schemas = [...new Set(sets.map((set) => set.migrationsSchema))];
  const anchor = { schema: platformMigrations.migrationsSchema, table: TENANT_COLOCATION_TABLE };
  // Each set's bookkeeping table in set order, the anchor right after the platform set's.
  const internal = sets.flatMap((set) => {
    const bookkeeping = { schema: set.migrationsSchema, table: set.migrationsTable };
    return set === platformMigrations ? [bookkeeping, anchor] : [bookkeeping];
  });
  if (!sets.includes(platformMigrations)) internal.push(anchor);
  return {
    schemas,
    internalSchemas: internal.map((table) => table.schema),
    internalTables: internal.map((table) => table.table),
  };
}

/**
 * Asks both connections every check, in a fixed order, and returns every finding (none = pass).
 * Package-internal: `DatabaseModule` runs it through `runBootGuard`.
 */
export async function inspectDatabase(
  target: BootGuardTarget,
): Promise<readonly BootGuardFinding[]> {
  const { runtime, system } = target;
  const { schemas, internalSchemas, internalTables } = scopeOf(target.sets);
  const findings: BootGuardFinding[] = [];

  await check(findings, 'runtime.not-superuser', async () =>
    flagOf(await query(runtime, SUPERUSER_SQL))
      ? 'the runtime connection (DATABASE_URL) logs in as a superuser, which bypasses RLS'
      : null,
  );
  await check(findings, 'runtime.no-bypassrls', async () =>
    flagOf(await query(runtime, BYPASSRLS_SQL))
      ? 'the runtime connection (DATABASE_URL) has BYPASSRLS; it must be app_runtime (NOBYPASSRLS)'
      : null,
  );
  await check(findings, 'runtime.owns-no-table', async () => {
    const owned = namesOf(await query(runtime, OWNED_SQL, [schemas]));
    return owned.length === 0
      ? null
      : `the runtime connection owns, or is a member of a role that owns: ${list(owned)}`;
  });
  await check(findings, 'runtime.rls-forced', async () => {
    const open = namesOf(await query(runtime, RLS_SQL, [schemas, internalSchemas, internalTables]));
    return open.length === 0
      ? null
      : `row-level security is not enabled and forced on: ${list(open)}`;
  });
  await check(findings, 'runtime.no-bookkeeping-privilege', async () => {
    const granted = namesOf(
      await query(runtime, INTERNAL_PRIVILEGE_SQL, [internalSchemas, internalTables]),
    );
    return granted.length === 0
      ? null
      : `the runtime connection holds privileges on internal tables: ${list(granted)}`;
  });
  await check(findings, 'runtime.citus-propagate-set-commands', async () =>
    citusVerdict('runtime', propagateSettingOf(await query(runtime, CITUS_SQL))),
  );

  if (system === null) return findings;

  await check(findings, 'system.not-superuser', async () =>
    flagOf(await query(system, SUPERUSER_SQL))
      ? 'the system connection (DATABASE_SYSTEM_URL) logs in as a superuser; it must be app_system'
      : null,
  );
  await check(findings, 'system.bypassrls', async () =>
    flagOf(await query(system, BYPASSRLS_SQL))
      ? null
      : 'the system connection (DATABASE_SYSTEM_URL) lacks BYPASSRLS; it must be app_system',
  );
  await check(findings, 'system.owns-no-table', async () => {
    const owned = namesOf(await query(system, OWNED_SQL, [schemas]));
    return owned.length === 0
      ? null
      : `the system connection owns, or is a member of a role that owns: ${list(owned)}`;
  });
  await check(findings, 'system.citus-propagate-set-commands', async () =>
    citusVerdict('system', propagateSettingOf(await query(system, CITUS_SQL))),
  );
  await check(findings, 'system.distinct-user', async () => {
    const runtimeUser = userOf(await query(runtime, CURRENT_USER_SQL));
    const systemUser = userOf(await query(system, CURRENT_USER_SQL));
    return runtimeUser === systemUser
      ? `the system and runtime connections both log in as ${runtimeUser}`
      : null;
  });
  return findings;
}

/**
 * `off`: sends nothing (fake databases only; production config rejects it). `warn`: logs each
 * finding and resolves with them. `enforce`: throws `DatabaseBootGuardError` with every finding.
 */
export async function runBootGuard(
  mode: BootGuardMode,
  target: BootGuardTarget,
  logger: BootGuardLogger,
): Promise<readonly BootGuardFinding[]> {
  if (mode === 'off') {
    logger.warn(
      'Database boot guard is off (DATABASE_BOOT_GUARD=off): roles and RLS are unchecked',
    );
    return [];
  }
  const findings = await inspectDatabase(target);
  if (findings.length === 0) {
    logger.log(`Database boot guard (${mode}): roles, RLS and grants as required`);
    return findings;
  }
  if (mode === 'enforce') throw new DatabaseBootGuardError(findings);
  for (const finding of findings) {
    logger.warn(`Database boot guard (warn): ${finding.check}: ${finding.detail}`);
  }
  return findings;
}

import { describe, expect, it, vi } from 'vitest';
import { createFakeSql, type FakeSql } from '../../test/fake-sql.js';
import type { DatabaseMigrationSet } from '../database.types.js';
import { MIGRATIONS_TABLE } from '../migrator/migrations.constants.js';
import { platformMigrations } from '../platform/platform.migrations.js';
import {
  type BootGuardFinding,
  DatabaseBootGuardError,
  inspectDatabase,
  runBootGuard,
} from './boot-guard.js';

/** A domain set next to the platform set: its schema and bookkeeping table are checked too. */
const parcels: DatabaseMigrationSet = {
  name: 'parcels',
  folder: '/migrations/parcels',
  migrationsSchema: 'parcels',
  migrationsTable: MIGRATIONS_TABLE,
};
const SETS = [platformMigrations, parcels];

/** Which check a statement belongs to (each check sends one statement). */
type Kind = 'superuser' | 'bypassrls' | 'owned' | 'rls' | 'privilege' | 'citus' | 'user';
const kindOf = (query: string): Kind => {
  if (query.includes('rolsuper')) return 'superuser';
  if (query.includes('rolbypassrls')) return 'bypassrls';
  if (query.includes('pg_has_role')) return 'owned';
  if (query.includes('relforcerowsecurity')) return 'rls';
  if (query.includes('has_table_privilege')) return 'privilege';
  if (query.includes('citus_enabled')) return 'citus';
  if (query.includes('current_user::text as name')) return 'user';
  throw new Error(`unexpected statement: ${query}`);
};

type Answers = Partial<Record<Kind, unknown[] | Error>>;
const GOOD_RUNTIME: Answers = {
  superuser: [{ flag: false }],
  bypassrls: [{ flag: false }],
  owned: [],
  rls: [],
  privilege: [],
  citus: [{ citus: true, setting: 'local' }],
  user: [{ name: 'app_runtime' }],
};
const GOOD_SYSTEM: Answers = {
  superuser: [{ flag: false }],
  bypassrls: [{ flag: true }],
  owned: [],
  citus: [{ citus: true, setting: 'local' }],
  user: [{ name: 'app_system' }],
};

/** A fake pool answering each check from `answers`; a missing answer is an unexpected statement. */
const connection = (answers: Answers): FakeSql =>
  createFakeSql((query) => {
    const answer = answers[kindOf(query)];
    if (answer === undefined) throw new Error(`no answer for: ${query}`);
    if (answer instanceof Error) throw answer;
    return answer;
  });

const inspect = (
  runtime: Answers = GOOD_RUNTIME,
  system: Answers | null = GOOD_SYSTEM,
): Promise<readonly BootGuardFinding[]> =>
  inspectDatabase({
    runtime: connection(runtime),
    system: system === null ? null : connection(system),
    sets: SETS,
  });

const checksOf = (findings: readonly BootGuardFinding[]): string[] =>
  findings.map((finding) => finding.check);

const silentLogger = () => ({ log: vi.fn(), warn: vi.fn() });

describe('inspectDatabase', () => {
  it('finds nothing when every answer is good (with and without a system pool)', async () => {
    expect(await inspect()).toEqual([]);
    expect(await inspect(GOOD_RUNTIME, null)).toEqual([]);
  });

  it('a Citus-less server needs no propagate setting', async () => {
    const plain = { citus: [{ citus: false, setting: null }] };
    expect(await inspect({ ...GOOD_RUNTIME, ...plain }, { ...GOOD_SYSTEM, ...plain })).toEqual([]);
  });

  it('sends the schemas and internal tables as bound parameters, never in the SQL text', async () => {
    const runtime = connection(GOOD_RUNTIME);
    await inspectDatabase({ runtime, system: null, sets: SETS });
    const calls = runtime.unsafe.mock.calls;
    const params = (kind: Kind): unknown[] | undefined =>
      calls.find(([query]) => kindOf(query) === kind)?.[1];
    expect(params('owned')).toEqual([['app', 'parcels']]);
    const internal = [
      ['app', 'app', 'app', 'parcels', 'parcels'],
      [
        '__drizzle_migrations',
        'tenant_colocation',
        '__online_migrations',
        '__drizzle_migrations',
        '__online_migrations',
      ],
    ];
    expect(params('rls')).toEqual([['app', 'parcels'], ...internal]);
    expect(params('privilege')).toEqual(internal);
    for (const [query] of calls) {
      expect(query).not.toMatch(
        /parcels|__drizzle_migrations|__online_migrations|tenant_colocation/,
      );
    }
  });

  it("lists each schema's __online_migrations once, whether or not a set has online steps now", async () => {
    // The table outlives an onlineFolder: a replica of the previous release, a rollback or a
    // removed folder still meets it. A listed table that does not exist matches nothing.
    const runtime = connection(GOOD_RUNTIME);
    const audit = {
      ...parcels,
      name: 'audit',
      migrationsTable: '__audit_migrations',
      onlineFolder: '/migrations/audit/online',
    };
    await inspectDatabase({ runtime, system: null, sets: [platformMigrations, parcels, audit] });
    const calls = runtime.unsafe.mock.calls;
    const params = (kind: Kind): unknown[] | undefined =>
      calls.find(([query]) => kindOf(query) === kind)?.[1];
    expect(params('privilege')).toEqual([
      ['app', 'app', 'app', 'parcels', 'parcels', 'parcels'],
      [
        '__drizzle_migrations',
        'tenant_colocation',
        '__online_migrations',
        '__drizzle_migrations',
        '__online_migrations',
        '__audit_migrations',
      ],
    ]);
  });

  describe('each single bad answer gives exactly its finding', () => {
    it.each<[string, Answers, Answers | null, string, RegExp]>([
      [
        'runtime superuser',
        { superuser: [{ flag: true }] },
        null,
        'runtime.not-superuser',
        /superuser/,
      ],
      [
        'runtime BYPASSRLS',
        { bypassrls: [{ flag: true }] },
        null,
        'runtime.no-bypassrls',
        /BYPASSRLS/,
      ],
      [
        'runtime owns a table',
        { owned: [{ name: 'parcels.parcels' }] },
        null,
        'runtime.owns-no-table',
        /parcels\.parcels/,
      ],
      [
        'a table without forced RLS',
        { rls: [{ name: 'parcels.parcels' }, { name: 'parcels.labels' }] },
        null,
        'runtime.rls-forced',
        /parcels\.parcels, parcels\.labels/,
      ],
      [
        'a privilege on a bookkeeping table',
        { privilege: [{ name: 'parcels.__drizzle_migrations' }] },
        null,
        'runtime.no-bookkeeping-privilege',
        /parcels\.__drizzle_migrations/,
      ],
      [
        'runtime propagate_set_commands not local on Citus',
        { citus: [{ citus: true, setting: 'none' }] },
        null,
        'runtime.citus-propagate-set-commands',
        /'none'/,
      ],
      [
        'system superuser',
        {},
        { superuser: [{ flag: true }] },
        'system.not-superuser',
        /superuser/,
      ],
      [
        'system without BYPASSRLS',
        {},
        { bypassrls: [{ flag: false }] },
        'system.bypassrls',
        /BYPASSRLS/,
      ],
      [
        'system owns a table',
        {},
        { owned: [{ name: 'app.tenant_colocation' }] },
        'system.owns-no-table',
        /app\.tenant_colocation/,
      ],
      [
        'system propagate_set_commands not local on Citus',
        {},
        { citus: [{ citus: true, setting: null }] },
        'system.citus-propagate-set-commands',
        /not set/,
      ],
      [
        'system logs in as the runtime user',
        {},
        { user: [{ name: 'app_runtime' }] },
        'system.distinct-user',
        /app_runtime/,
      ],
    ])('%s', async (_name, runtime, system, check, detail) => {
      const findings = await inspect(
        { ...GOOD_RUNTIME, ...runtime },
        { ...GOOD_SYSTEM, ...(system ?? {}) },
      );
      expect(checksOf(findings)).toEqual([check]);
      expect(findings[0]?.detail).toMatch(detail);
    });
  });

  describe('fails closed: an erroring query or an unexpected shape is a finding', () => {
    it.each<[Kind, string]>([
      ['superuser', 'runtime.not-superuser'],
      ['bypassrls', 'runtime.no-bypassrls'],
      ['owned', 'runtime.owns-no-table'],
      ['rls', 'runtime.rls-forced'],
      ['privilege', 'runtime.no-bookkeeping-privilege'],
      ['citus', 'runtime.citus-propagate-set-commands'],
      ['user', 'system.distinct-user'],
    ])('a rejecting %s query names %s', async (kind, check) => {
      const findings = await inspect({
        ...GOOD_RUNTIME,
        [kind]: new Error('permission denied for function citus_enabled'),
      });
      expect(checksOf(findings)).toEqual([check]);
      expect(findings[0]?.detail).toMatch(/query failed: permission denied/);
    });

    it.each<[string, Answers, string]>([
      ['no row', { superuser: [] }, 'runtime.not-superuser'],
      ['two rows', { bypassrls: [{ flag: false }, { flag: false }] }, 'runtime.no-bypassrls'],
      ['a string flag', { superuser: [{ flag: 'false' }] }, 'runtime.not-superuser'],
      ['a null flag', { bypassrls: [{ flag: null }] }, 'runtime.no-bypassrls'],
      ['a list row without a name', { owned: [{ relname: 'x' }] }, 'runtime.owns-no-table'],
      ['a list that is not an array', { rls: { count: 0 } as never }, 'runtime.rls-forced'],
      ['a numeric name', { privilege: [{ name: 1 }] }, 'runtime.no-bookkeeping-privilege'],
      [
        'a citus flag that is not boolean',
        { citus: [{ citus: 't', setting: 'local' }] },
        'runtime.citus-propagate-set-commands',
      ],
      [
        'a numeric setting',
        { citus: [{ citus: true, setting: 1 }] },
        'runtime.citus-propagate-set-commands',
      ],
      ['a select-1 answer', { superuser: [{ '?column?': 1 }] }, 'runtime.not-superuser'],
      ['an empty user', { user: [{ name: '' }] }, 'system.distinct-user'],
    ])('%s', async (_name, runtime, check) => {
      const findings = await inspect({ ...GOOD_RUNTIME, ...runtime });
      expect(checksOf(findings)).toEqual([check]);
      expect(findings[0]?.detail).toMatch(/unexpected answer/);
    });

    it('a system pool that answers nothing gives one finding per system check', async () => {
      const failing = new Error('connection refused');
      const findings = await inspect(GOOD_RUNTIME, {
        superuser: failing,
        bypassrls: failing,
        owned: failing,
        citus: failing,
        user: failing,
      });
      expect(checksOf(findings)).toEqual([
        'system.not-superuser',
        'system.bypassrls',
        'system.owns-no-table',
        'system.citus-propagate-set-commands',
        'system.distinct-user',
      ]);
    });
  });
});

describe('runBootGuard', () => {
  const badRuntime: Answers = {
    ...GOOD_RUNTIME,
    superuser: [{ flag: true }],
    rls: [{ name: 'parcels.parcels' }],
  };

  it('enforce: throws DatabaseBootGuardError carrying every finding', async () => {
    const logger = silentLogger();
    const error = await runBootGuard(
      'enforce',
      { runtime: connection(badRuntime), system: connection(GOOD_SYSTEM), sets: SETS },
      logger,
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DatabaseBootGuardError);
    const findings = (error as DatabaseBootGuardError).findings;
    expect(checksOf(findings)).toEqual(['runtime.not-superuser', 'runtime.rls-forced']);
    expect(Object.isFrozen(findings)).toBe(true);
    expect((error as Error).name).toBe('DatabaseBootGuardError');
    expect((error as Error).message).toMatch(/2 findings/);
    expect((error as Error).message).toMatch(/runtime\.not-superuser/);
    expect((error as Error).message).toMatch(/runtime\.rls-forced: .*parcels\.parcels/);
  });

  it('enforce: a fail-closed finding refuses too', async () => {
    await expect(
      runBootGuard(
        'enforce',
        {
          runtime: connection({ ...GOOD_RUNTIME, citus: new Error('boom') }),
          system: null,
          sets: SETS,
        },
        silentLogger(),
      ),
    ).rejects.toBeInstanceOf(DatabaseBootGuardError);
  });

  it('enforce: refuses without a system connection (DATABASE_SYSTEM_URL unset)', async () => {
    const error = await runBootGuard(
      'enforce',
      { runtime: connection(GOOD_RUNTIME), system: null, sets: SETS },
      silentLogger(),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DatabaseBootGuardError);
    expect((error as DatabaseBootGuardError).findings).toEqual([
      {
        check: 'system.configured',
        detail: expect.stringContaining('DATABASE_SYSTEM_URL') as unknown,
      },
    ]);
    // Next to the runtime findings, never instead of them.
    const both = await runBootGuard(
      'enforce',
      { runtime: connection(badRuntime), system: null, sets: SETS },
      silentLogger(),
    ).catch((caught: unknown) => caught);
    expect(checksOf((both as DatabaseBootGuardError).findings)).toEqual([
      'runtime.not-superuser',
      'runtime.rls-forced',
      'system.configured',
    ]);
  });

  it('warn: a missing system connection is no finding (development and tests may omit it)', async () => {
    const logger = silentLogger();
    await expect(
      runBootGuard('warn', { runtime: connection(GOOD_RUNTIME), system: null, sets: SETS }, logger),
    ).resolves.toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('enforce: resolves with no finding', async () => {
    const logger = silentLogger();
    await expect(
      runBootGuard(
        'enforce',
        { runtime: connection(GOOD_RUNTIME), system: connection(GOOD_SYSTEM), sets: SETS },
        logger,
      ),
    ).resolves.toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('warn: logs each finding and resolves with them', async () => {
    const logger = silentLogger();
    const findings = await runBootGuard(
      'warn',
      { runtime: connection(badRuntime), system: null, sets: SETS },
      logger,
    );
    expect(checksOf(findings)).toEqual(['runtime.not-superuser', 'runtime.rls-forced']);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/runtime\.not-superuser/));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/parcels\.parcels/));
  });

  it('off: sends no query', async () => {
    const runtime = connection(GOOD_RUNTIME);
    const system = connection(GOOD_SYSTEM);
    await expect(
      runBootGuard('off', { runtime, system, sets: SETS }, silentLogger()),
    ).resolves.toEqual([]);
    expect(runtime.queries).toEqual([]);
    expect(system.queries).toEqual([]);
  });
});

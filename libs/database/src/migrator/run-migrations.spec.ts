import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LoggerService } from '@nestjs/common';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeSql } from '../../test/fake-sql.js';
import type { DatabaseMigrationSet } from '../database.types.js';
import { platformMigrations } from '../platform/platform.migrations.js';
import { MIGRATIONS_ADVISORY_LOCK_ID, MIGRATIONS_TABLE } from './migrations.constants.js';
import { runMigrations } from './run-migrations.js';

vi.mock('postgres', () => ({ default: vi.fn() }));
// drizzle's migrator itself is exercised by database.int-spec.ts; here only its calls matter.
vi.mock('drizzle-orm/postgres-js/migrator', () => ({ migrate: vi.fn(async () => undefined) }));

const URL = 'postgres://app:app@localhost:5432/app';
/** Files in the real platform journal: every run starts with the platform set. */
const PLATFORM_TOTAL = (
  JSON.parse(readFileSync(join(platformMigrations.folder, 'meta', '_journal.json'), 'utf8')) as {
    entries: unknown[];
  }
).entries.length;
/** drizzle's migrate() config for the platform set. */
const PLATFORM_MIGRATE_CONFIG = {
  migrationsFolder: platformMigrations.folder,
  migrationsSchema: 'app',
  migrationsTable: MIGRATIONS_TABLE,
};
/** The sets in the order every caller passes them: `withPlatformMigrations(sets)`. */
const afterPlatform = (...sets: DatabaseMigrationSet[]): DatabaseMigrationSet[] => [
  platformMigrations,
  ...sets,
];
/** What PgBouncer answers to the runner's statement_timeout startup parameter (sharding design P-12). */
const startupRejected = (): Error =>
  Object.assign(new Error('unsupported startup parameter: statement_timeout'), { code: '08P01' });
/** The online-step counts of a set without an `online/` folder, and of a run without any. */
const NO_ONLINE = { total: 0, applied: 0 };
const silentLogger = (): LoggerService => ({
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
});

describe('runMigrations', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'db-migrations-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A journal entry as drizzle-kit writes it (`when` grows with `idx`). */
  const journalEntry = (idx: number, overrides: Record<string, unknown> = {}) => ({
    idx,
    version: '7',
    when: 1_700_000_000_000 + idx,
    tag: `${String(idx).padStart(4, '0')}_step`,
    breakpoints: true,
    ...overrides,
  });

  /** A set whose folder holds a journal with `entries`, or no journal at all for `null`. */
  const journalSet = (name: string, entries: object[] | null): DatabaseMigrationSet => {
    const folder = join(dir, name);
    mkdirSync(join(folder, 'meta'), { recursive: true });
    if (entries !== null) {
      writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify({ entries }));
    }
    return { name, folder, migrationsSchema: name, migrationsTable: MIGRATIONS_TABLE };
  };

  /** A set whose folder holds a valid journal listing `tags`, or no journal at all for `null`. */
  const migrationSet = (name: string, tags: string[] | null): DatabaseMigrationSet =>
    journalSet(name, tags?.map((tag, idx) => journalEntry(idx, { tag })) ?? null);

  it('rejects a set without a drizzle journal before connecting', async () => {
    const empty = migrationSet('empty', null);
    await expect(
      runMigrations(URL, { migrations: afterPlatform(empty), logger: silentLogger() }),
    ).rejects.toThrow(
      `Migration set "empty" has no drizzle journal (${join(empty.folder, 'meta', '_journal.json')})`,
    );
    expect(postgres).not.toHaveBeenCalled();
  });

  it.each([
    ['no platform set', () => [migrationSet('orders', ['0000_init'])]],
    [
      'the platform set after another set',
      () => [migrationSet('orders', ['0000_init']), platformMigrations],
    ],
  ])('rejects %s before connecting: the platform set runs first', async (_label, sets) => {
    await expect(
      runMigrations(URL, { migrations: sets(), logger: silentLogger() }),
    ).rejects.toThrow(/The platform migration set must run first/);
    expect(postgres).not.toHaveBeenCalled();
  });

  it('rejects two sets sharing one bookkeeping table before connecting', async () => {
    const orders = migrationSet('orders', ['0000_init']);
    const audit = { ...migrationSet('audit', ['0000_init']), migrationsSchema: 'orders' };
    await expect(
      runMigrations(URL, { migrations: afterPlatform(orders, audit), logger: silentLogger() }),
    ).rejects.toThrow(/"orders" and "audit" share orders\.__drizzle_migrations/);
    expect(postgres).not.toHaveBeenCalled();
  });

  it('rejects a malformed journal before connecting', async () => {
    const broken = migrationSet('broken', null);
    writeFileSync(
      join(broken.folder, 'meta', '_journal.json'),
      JSON.stringify({ entries: 'nope' }),
    );
    await expect(
      runMigrations(URL, { migrations: afterPlatform(broken), logger: silentLogger() }),
    ).rejects.toThrow(/Invalid drizzle migration journal/);
    expect(postgres).not.toHaveBeenCalled();
  });

  it.each([
    ['an entry whose tag is not a string', [journalEntry(0, { tag: 42 })], 'entries[0].tag'],
    ['an entry without `when`', [journalEntry(0, { when: undefined })], 'entries[0].when'],
    ['a fractional `when`', [journalEntry(0, { when: 1.5 })], 'entries[0].when'],
    ['a `when` that is not positive', [journalEntry(0, { when: 0 })], 'entries[0].when'],
    [
      'an entry without boolean `breakpoints`',
      [journalEntry(0, { breakpoints: 'yes' })],
      'entries[0].breakpoints',
    ],
    [
      "a `when` equal to the previous entry's",
      [journalEntry(0), journalEntry(1, { when: journalEntry(0).when })],
      'entries[1].when',
    ],
    [
      "a `when` older than the previous entry's (drizzle would skip the file)",
      [journalEntry(0), journalEntry(1), journalEntry(2, { when: 1_600_000_000_000 })],
      'entries[2].when',
    ],
  ])('rejects a journal with %s before connecting', async (_label, entries, path) => {
    const set = journalSet('bad', entries);
    const error = await runMigrations(URL, {
      migrations: afterPlatform(set),
      logger: silentLogger(),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      `Invalid drizzle migration journal: ${join(set.folder, 'meta', '_journal.json')}`,
    );
    expect((error as Error).message).toContain(`→ at ${path}`);
    expect(postgres).not.toHaveBeenCalled();
  });

  it('finds the bookkeeping table of a mixed-case schema: the identifiers are bound, not folded', async () => {
    const orders = migrationSet('Orders', ['0000_init']);
    let rows = 0;
    vi.mocked(migrate).mockImplementation(async (_db, config) => {
      if (config.migrationsSchema === 'Orders') rows = 1;
    });
    const lookups: unknown[][] = [];
    const sql = createFakeSql((query, values) => {
      if (query.includes('pg_try_advisory_lock')) return [{ locked: true }];
      if (query.includes('to_regclass')) {
        lookups.push(values);
        // Postgres folds an unquoted name to lower case, so "Orders" is found only when the schema
        // and table reach it as separate values (quoted with %I), never as one 'Orders.x' string.
        return [{ exists: values.length === 2 && values[0] === 'Orders' }];
      }
      if (query.startsWith('select count(*)')) return [{ count: rows }];
      return [];
    });
    vi.mocked(postgres).mockReturnValue(sql as never);

    const summary = await runMigrations(URL, {
      migrations: afterPlatform(orders),
      logger: silentLogger(),
    });

    expect(lookups).toEqual([
      ['app', MIGRATIONS_TABLE],
      ['app', MIGRATIONS_TABLE],
      ['Orders', MIGRATIONS_TABLE],
      ['Orders', MIGRATIONS_TABLE],
    ]);
    expect(summary).toEqual({
      sets: [
        {
          name: 'platform',
          folder: platformMigrations.folder,
          total: PLATFORM_TOTAL,
          applied: 0,
          online: NO_ONLINE,
        },
        { name: 'Orders', folder: orders.folder, total: 1, applied: 1, online: NO_ONLINE },
      ],
      total: PLATFORM_TOTAL + 1,
      applied: 1,
      online: NO_ONLINE,
    });
  });

  it('applies the sets in array order on ONE session, under ONE lock, and sums the summary', async () => {
    const inventory = migrationSet('inventory', ['0000_init']);
    const pricing = migrationSet('pricing', ['0000_init', '0001_more']);
    const appliedBySchema = new Map<string, number>();
    const events: string[] = [];
    vi.mocked(migrate).mockImplementation(async (_db, config) => {
      const schema = config.migrationsSchema ?? '';
      events.push(`migrate ${schema}`);
      appliedBySchema.set(schema, schema === 'pricing' ? 2 : schema === 'app' ? PLATFORM_TOTAL : 1);
    });
    const sql = createFakeSql((query, values) => {
      if (query.includes('pg_try_advisory_lock')) {
        events.push('lock');
        return [{ locked: true }];
      }
      if (query.includes('pg_advisory_unlock')) {
        events.push('unlock');
        return [];
      }
      if (query.includes('to_regclass')) return [{ exists: true }];
      if (query.startsWith('select count(*)')) {
        const [schema] = values as [{ identifier: string }];
        return [{ count: appliedBySchema.get(schema.identifier) ?? 0 }];
      }
      return [];
    });
    vi.mocked(postgres).mockReturnValue(sql as never);

    const summary = await runMigrations(URL, {
      migrations: afterPlatform(inventory, pricing),
      logger: silentLogger(),
    });

    expect(events).toEqual([
      'lock',
      'migrate app',
      'migrate inventory',
      'migrate pricing',
      'unlock',
    ]);
    expect(vi.mocked(migrate).mock.calls.map(([, config]) => config)).toEqual([
      PLATFORM_MIGRATE_CONFIG,
      {
        migrationsFolder: inventory.folder,
        migrationsSchema: 'inventory',
        migrationsTable: MIGRATIONS_TABLE,
      },
      {
        migrationsFolder: pricing.folder,
        migrationsSchema: 'pricing',
        migrationsTable: MIGRATIONS_TABLE,
      },
    ]);
    expect(summary).toEqual({
      sets: [
        {
          name: 'platform',
          folder: platformMigrations.folder,
          total: PLATFORM_TOTAL,
          applied: PLATFORM_TOTAL,
          online: NO_ONLINE,
        },
        { name: 'inventory', folder: inventory.folder, total: 1, applied: 1, online: NO_ONLINE },
        { name: 'pricing', folder: pricing.folder, total: 2, applied: 2, online: NO_ONLINE },
      ],
      total: PLATFORM_TOTAL + 3,
      applied: PLATFORM_TOTAL + 3,
      online: NO_ONLINE,
    });
    expect(postgres).toHaveBeenCalledTimes(1);
    expect(sql.end).toHaveBeenCalledWith({ timeout: 5 });
  });

  it('on Citus, checks for the coordinator, then pins local execution and sequential shard modification before the first set', async () => {
    const orders = migrationSet('orders', ['0000_init']);
    const events: string[] = [];
    vi.mocked(migrate).mockImplementation(async () => {
      events.push('migrate');
    });
    const sql = createFakeSql((query) => {
      if (query.includes('pg_try_advisory_lock')) {
        events.push('lock');
        return [{ locked: true }];
      }
      if (query.includes("extname = 'citus'")) return [{ citus: true }];
      if (query.includes('citus_is_coordinator()')) {
        events.push('coordinator?');
        return [{ coordinator: true }];
      }
      if (query.startsWith('set citus.')) events.push(query);
      return [];
    });
    vi.mocked(postgres).mockReturnValue(sql as never);
    const logger = silentLogger();

    await runMigrations(URL, { migrations: afterPlatform(orders), logger });

    expect(events).toEqual([
      'coordinator?',
      'lock',
      'set citus.enable_local_execution to on',
      "set citus.multi_shard_modify_mode to 'sequential'",
      'migrate',
      'migrate',
    ]);
    expect(logger.log).toHaveBeenCalledWith(
      'Citus detected: migration session uses local execution and sequential shard modification',
    );
  });

  it.each([
    ['citus_is_coordinator() is false', [{ coordinator: false }]],
    ['the check returns no row', []],
  ])(
    'on Citus, refuses a server that is not the coordinator (%s): no lock, no set',
    async (_label, answer) => {
      const sql = createFakeSql((query) => {
        if (query.includes("extname = 'citus'")) return [{ citus: true }];
        if (query.includes('citus_is_coordinator()')) return answer;
        if (query.includes('pg_try_advisory_lock')) return [{ locked: true }];
        return [];
      });
      vi.mocked(postgres).mockReturnValue(sql as never);

      await expect(
        runMigrations(URL, {
          migrations: afterPlatform(migrationSet('orders', ['0000_init'])),
          logger: silentLogger(),
        }),
      ).rejects.toThrow(
        /not the Citus coordinator .*DATABASE_MIGRATION_URL must point at the coordinator directly/,
      );
      expect(sql.queries.some((query) => query.includes('pg_try_advisory_lock'))).toBe(false);
      expect(migrate).not.toHaveBeenCalled();
      expect(sql.end).toHaveBeenCalledWith({ timeout: 5 });
    },
  );

  it('without the citus extension, sends no Citus setting and no coordinator check', async () => {
    const orders = migrationSet('orders', ['0000_init']);
    const sql = createFakeSql((query) => {
      if (query.includes('pg_try_advisory_lock')) return [{ locked: true }];
      if (query.includes("extname = 'citus'")) return [{ citus: false }];
      return [];
    });
    vi.mocked(postgres).mockReturnValue(sql as never);

    await runMigrations(URL, { migrations: afterPlatform(orders), logger: silentLogger() });

    expect(sql.queries.some((query) => query.includes("extname = 'citus'"))).toBe(true);
    expect(sql.queries.some((query) => query.includes('citus_is_coordinator'))).toBe(false);
    expect(sql.queries.some((query) => query.startsWith('set citus.'))).toBe(false);
  });

  it('rethrows a startup rejection (08P01, PgBouncer) naming DATABASE_MIGRATION_URL, before any lock', async () => {
    const rejection = startupRejected();
    const sql = createFakeSql(() => {
      throw rejection;
    });
    vi.mocked(postgres).mockReturnValue(sql as never);

    const error = await runMigrations(URL, {
      migrations: afterPlatform(migrationSet('orders', ['0000_init'])),
      logger: silentLogger(),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      message: expect.stringMatching(
        /^DATABASE_MIGRATION_URL must connect directly to Postgres \(the Citus coordinator\), never through PgBouncer: .*08P01.*unsupported startup parameter: statement_timeout/,
      ) as unknown,
      cause: rejection,
    });
    expect(sql.queries).toHaveLength(1);
    expect(migrate).not.toHaveBeenCalled();
    expect(sql.end).toHaveBeenCalledWith({ timeout: 5 });
  });

  it('rethrows any other connect error unchanged', async () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
      code: 'ECONNREFUSED',
    });
    const sql = createFakeSql(() => {
      throw refused;
    });
    vi.mocked(postgres).mockReturnValue(sql as never);

    await expect(
      runMigrations(URL, { migrations: afterPlatform(), logger: silentLogger() }),
    ).rejects.toBe(refused);
  });

  it('stops at a failing set: names it, never attempts the next one, still unlocks and closes', async () => {
    const inventory = migrationSet('inventory', ['0000_init']);
    const pricing = migrationSet('pricing', ['0000_init']);
    const audit = migrationSet('audit', ['0000_init']);
    const failure = new Error('relation "shipments" already exists');
    const events: string[] = [];
    vi.mocked(migrate).mockImplementation(async (_db, config) => {
      events.push(`migrate ${config.migrationsSchema ?? ''}`);
      if (config.migrationsSchema === 'pricing') throw failure;
    });
    const sql = createFakeSql((query) => {
      if (query.includes('pg_try_advisory_lock')) {
        events.push('lock');
        return [{ locked: true }];
      }
      if (query.includes('pg_advisory_unlock')) events.push('unlock');
      return [];
    });
    vi.mocked(postgres).mockReturnValue(sql as never);

    const error = await runMigrations(URL, {
      migrations: afterPlatform(inventory, pricing, audit),
      logger: silentLogger(),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      message: `Migration set "pricing" (${pricing.folder}) failed`,
      cause: failure,
    });
    expect(events).toEqual([
      'lock',
      'migrate app',
      'migrate inventory',
      'migrate pricing',
      'unlock',
    ]);
    expect(sql.end).toHaveBeenCalledWith({ timeout: 5 });
  });

  it('waits for the advisory lock, then gives up with a clear error and closes the client', async () => {
    const set = migrationSet('x', ['0000_x']);
    const lockValues: unknown[][] = [];
    const sql = createFakeSql((query, values) => {
      if (query.includes('pg_try_advisory_lock')) {
        lockValues.push(values);
        return [{ locked: false }];
      }
      return [];
    });
    vi.mocked(postgres).mockReturnValue(sql as never);
    const logger = silentLogger();

    await expect(
      runMigrations(URL, {
        migrations: afterPlatform(set),
        logger,
        lockTimeoutMs: 30,
        lockPollIntervalMs: 5,
        applicationName: 'svc',
      }),
    ).rejects.toThrow(/Timed out after 30ms waiting for the migrations advisory lock/);

    // single-session client: the lock and migrate() must share one connection that never recycles.
    // statement_timeout is the STRING '0': postgres.js leaves falsy values out of the startup
    // message, so a number 0 would never be sent (and PgBouncer could not reject it, 08P01).
    expect(postgres).toHaveBeenCalledWith(
      URL,
      expect.objectContaining({
        max: 1,
        max_lifetime: null,
        connection: {
          application_name: 'svc:migrate',
          statement_timeout: '0',
          lock_timeout: '5000',
        },
      }),
    );
    expect(lockValues.length).toBeGreaterThan(1);
    expect(lockValues[0]).toEqual([MIGRATIONS_ADVISORY_LOCK_ID]);
    expect(logger.log).toHaveBeenCalledTimes(1); // "waiting" logged once, not per poll
    expect(migrate).not.toHaveBeenCalled();
    expect(sql.queries.some((q) => q.includes('pg_advisory_unlock'))).toBe(false);
    expect(sql.end).toHaveBeenCalledWith({ timeout: 5 });
  });

  describe('lock waits (OPS-2)', () => {
    /** What drizzle throws when a statement hits lock_timeout: its query error around the driver's. */
    const lockTimeoutError = () => {
      const driver = Object.assign(new Error('canceling statement due to lock timeout'), {
        code: '55P03',
      });
      return { driver, wrapped: new Error('Failed query: alter table ...', { cause: driver }) };
    };

    it.each([
      ['5000 by default', {}, '5000'],
      ['the configured value', { lockWaitTimeoutMs: 500 }, '500'],
      // A string: postgres.js drops falsy startup values, so 0 must be '0' to override a role default.
      ['0 (disabled) as the string "0"', { lockWaitTimeoutMs: 0 }, '0'],
    ])('sends lock_timeout as a startup parameter: %s', async (_label, options, expected) => {
      const sql = createFakeSql((query) =>
        query.includes('pg_try_advisory_lock') ? [{ locked: true }] : [],
      );
      vi.mocked(postgres).mockReturnValue(sql as never);

      await runMigrations(URL, { migrations: afterPlatform(), logger: silentLogger(), ...options });

      expect(postgres).toHaveBeenCalledTimes(1); // plain Postgres: no preliminary connection
      expect(postgres).toHaveBeenCalledWith(
        URL,
        expect.objectContaining({
          connection: expect.objectContaining({
            statement_timeout: '0',
            lock_timeout: expected,
          }) as unknown,
        }),
      );
      expect(sql.queries.some((query) => query.includes('pg_db_role_setting'))).toBe(false);
      expect(sql.unsafe).not.toHaveBeenCalled();
    });

    /**
     * One connection of a Citus run, labelled `label` in `events`: the role's default lock_timeout
     * lives in `role.value` and changes on `alter role`; `lock` answers each advisory-lock poll.
     */
    const citusRoleConnection = (
      label: string,
      events: string[],
      role: { value: string },
      lock: () => boolean = () => true,
    ) =>
      createFakeSql((query) => {
        if (query.includes("extname = 'citus'")) return [{ citus: true }];
        if (query.includes('citus_is_coordinator()')) {
          events.push(`${label}: coordinator?`);
          return [{ coordinator: true }];
        }
        if (query.includes('pg_db_role_setting')) {
          events.push(`${label}: role default?`);
          return [{ setconfig: ['search_path=pg_catalog, public', `lock_timeout=${role.value}`] }];
        }
        if (query.startsWith('alter role')) {
          role.value = /= (\d+)$/.exec(query)?.[1] ?? '?';
          events.push(`${label}: ${query}`);
        }
        if (query.includes('pg_try_advisory_lock')) {
          const locked = lock();
          events.push(`${label}: ${locked ? 'lock' : 'lock busy'}`);
          return [{ locked }];
        }
        if (query.startsWith('set citus.')) events.push(`${label}: ${query}`);
        return [];
      });

    /** `postgres()` returns `fakes` in order, logging each open and close by its label. */
    const labelledConnections = (
      events: string[],
      fakes: [string, ReturnType<typeof createFakeSql>][],
    ) => {
      let next = 0;
      vi.mocked(postgres).mockImplementation((() => {
        const [label, fake] = fakes[next++] ?? [];
        if (label === undefined || fake === undefined) throw new Error('unexpected connection');
        events.push(`open ${label}`);
        fake.end.mockImplementation(async () => {
          events.push(`${label}: closed`);
        });
        return fake;
      }) as never);
    };

    it('on Citus, a preliminary connection checks the coordinator and closes; the role default is aligned on a throwaway connection only after the session holds the lock, before the first set', async () => {
      const orders = migrationSet('orders', ['0000_init']);
      const events: string[] = [];
      const role = { value: '2s' };
      vi.mocked(migrate).mockImplementation(async () => {
        events.push(`migrate (role default ${role.value})`);
      });
      const session = citusRoleConnection('session', events, role);
      labelledConnections(events, [
        ['preliminary', citusRoleConnection('preliminary', events, role)],
        ['session', session],
        ['align', citusRoleConnection('align', events, role)],
      ]);
      const logger = silentLogger();

      await runMigrations(URL, {
        migrations: afterPlatform(orders),
        logger,
        lockWaitTimeoutMs: 1500,
      });

      expect(events).toEqual([
        'open preliminary',
        'preliminary: coordinator?',
        'preliminary: closed',
        'open session',
        'session: lock',
        'open align',
        'align: role default?',
        'align: alter role current_user set lock_timeout = 1500',
        'align: closed',
        'session: set citus.enable_local_execution to on',
        "session: set citus.multi_shard_modify_mode to 'sequential'",
        'migrate (role default 1500)',
        'migrate (role default 1500)',
        'session: closed',
      ]);
      // Every connection carries the same startup parameters (the 08P01 check runs on the first).
      expect(vi.mocked(postgres).mock.calls.map(([, options]) => options?.connection)).toEqual(
        Array.from({ length: 3 }, () => ({
          application_name: 'app:migrate',
          statement_timeout: '0',
          lock_timeout: '1500',
        })),
      );
      expect(session.queries.some((query) => query.includes("extname = 'citus'"))).toBe(false);
      expect(logger.log).toHaveBeenCalledWith(
        expect.stringMatching(/lock_timeout.*1500ms.*was 2s/),
      );
    });

    it('on Citus, leaves the role default alone while another runner holds the lock, and realigns the online value a crashed holder left once the lock is taken, before the first set', async () => {
      const orders = migrationSet('orders', ['0000_init']);
      const events: string[] = [];
      // The holder is inside its online window when this runner starts: the default is matching
      // before it switches; it dies there, leaving the online value (0), and its lock goes away.
      const role = { value: '5000' };
      let polls = 0;
      const lock = (): boolean => {
        polls += 1;
        if (polls === 1) role.value = '0';
        return polls > 2;
      };
      vi.mocked(migrate).mockImplementation(async () => {
        events.push(`migrate (role default ${role.value})`);
      });
      labelledConnections(events, [
        ['preliminary', citusRoleConnection('preliminary', events, role)],
        ['session', citusRoleConnection('session', events, role, lock)],
        ['align', citusRoleConnection('align', events, role)],
      ]);

      await runMigrations(URL, {
        migrations: afterPlatform(orders),
        logger: silentLogger(),
        lockPollIntervalMs: 0,
      });

      expect(events.filter((event) => !event.includes('set citus.'))).toEqual([
        'open preliminary',
        'preliminary: coordinator?',
        'preliminary: closed',
        'open session',
        'session: lock busy',
        'session: lock busy',
        'session: lock',
        'open align',
        'align: role default?',
        'align: alter role current_user set lock_timeout = 5000',
        'align: closed',
        'migrate (role default 5000)',
        'migrate (role default 5000)',
        'session: closed',
      ]);
    });

    it.each([
      ['in milliseconds', 'lock_timeout=5000'],
      ['in seconds', 'lock_timeout=5s'],
    ])(
      'on Citus, leaves a role default that already equals the timeout (%s) alone',
      async (_label, stored) => {
        const sql = createFakeSql((query) => {
          if (query.includes("extname = 'citus'")) return [{ citus: true }];
          if (query.includes('citus_is_coordinator()')) return [{ coordinator: true }];
          if (query.includes('pg_db_role_setting')) return [{ setconfig: [stored] }];
          if (query.includes('pg_try_advisory_lock')) return [{ locked: true }];
          return [];
        });
        vi.mocked(postgres).mockReturnValue(sql as never);

        await runMigrations(URL, { migrations: afterPlatform(), logger: silentLogger() });

        expect(sql.unsafe).not.toHaveBeenCalled();
        expect(postgres).toHaveBeenCalledTimes(3); // preliminary, session, alignment
      },
    );

    it('on Citus, sets a missing role default, also to 0 when the timeout is disabled', async () => {
      const sql = createFakeSql((query) => {
        if (query.includes("extname = 'citus'")) return [{ citus: true }];
        if (query.includes('citus_is_coordinator()')) return [{ coordinator: true }];
        if (query.includes('pg_try_advisory_lock')) return [{ locked: true }];
        return []; // no pg_db_role_setting row for the role
      });
      vi.mocked(postgres).mockReturnValue(sql as never);

      await runMigrations(URL, {
        migrations: afterPlatform(),
        logger: silentLogger(),
        lockWaitTimeoutMs: 0,
      });

      expect(sql.unsafe).toHaveBeenCalledTimes(1);
      expect(sql.unsafe).toHaveBeenCalledWith('alter role current_user set lock_timeout = 0');
    });

    it('retries a set that hit lock_timeout with backoff under the same lock, and applies it', async () => {
      const orders = migrationSet('orders', ['0000_init']);
      const { wrapped } = lockTimeoutError();
      const events: string[] = [];
      let ordersAttempts = 0;
      vi.mocked(migrate).mockImplementation(async (_db, config) => {
        events.push(`migrate ${config.migrationsSchema ?? ''}`);
        if (config.migrationsSchema === 'orders' && ++ordersAttempts < 3) throw wrapped;
      });
      const sql = createFakeSql((query) => {
        if (query.includes('pg_try_advisory_lock')) {
          events.push('lock');
          return [{ locked: true }];
        }
        if (query.includes('pg_advisory_unlock')) events.push('unlock');
        if (query.includes('to_regclass')) return [{ exists: true }];
        if (query.startsWith('select count(*)')) return [{ count: ordersAttempts >= 3 ? 1 : 0 }];
        return [];
      });
      vi.mocked(postgres).mockReturnValue(sql as never);
      const logger = silentLogger();

      const summary = await runMigrations(URL, {
        migrations: afterPlatform(orders),
        logger,
        lockWaitTimeoutMs: 500,
        lockWaitRetries: 2,
        lockWaitRetryDelayMs: 1,
      });

      expect(events).toEqual([
        'lock',
        'migrate app',
        'migrate orders',
        'migrate orders',
        'migrate orders',
        'unlock',
      ]);
      expect(summary.sets.at(-1)).toEqual({
        name: 'orders',
        folder: orders.folder,
        total: 1,
        applied: 1,
        online: NO_ONLINE,
      });
      expect(logger.warn).toHaveBeenCalledTimes(2);
      expect(logger.warn).toHaveBeenNthCalledWith(
        1,
        expect.stringMatching(
          /^orders: lock_timeout \(500ms\) expired \(55P03\); retry 1 of 2 in 1ms/,
        ),
      );
      expect(logger.warn).toHaveBeenNthCalledWith(
        2,
        expect.stringMatching(
          /^orders: lock_timeout \(500ms\) expired \(55P03\); retry 2 of 2 in 2ms/,
        ),
      );
    });

    it('gives up after the last retry naming the set and the lock timeout, with the 55P03 error as cause', async () => {
      const orders = migrationSet('orders', ['0000_init']);
      const audit = migrationSet('audit', ['0000_init']);
      const { driver, wrapped } = lockTimeoutError();
      const events: string[] = [];
      vi.mocked(migrate).mockImplementation(async (_db, config) => {
        events.push(`migrate ${config.migrationsSchema ?? ''}`);
        if (config.migrationsSchema === 'orders') throw wrapped;
      });
      const sql = createFakeSql((query) => {
        if (query.includes('pg_try_advisory_lock')) return [{ locked: true }];
        if (query.includes('pg_advisory_unlock')) events.push('unlock');
        return [];
      });
      vi.mocked(postgres).mockReturnValue(sql as never);

      const error = await runMigrations(URL, {
        migrations: afterPlatform(orders, audit),
        logger: silentLogger(),
        lockWaitTimeoutMs: 500,
        lockWaitRetries: 1,
        lockWaitRetryDelayMs: 1,
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({
        message: expect.stringMatching(
          /^Migration set "orders" \(.*\) failed: lock_timeout \(500ms\) expired on all 2 attempts \(SQLSTATE 55P03\)/,
        ) as unknown,
        cause: driver,
      });
      expect(events).toEqual(['migrate app', 'migrate orders', 'migrate orders', 'unlock']);
      expect(sql.end).toHaveBeenCalledWith({ timeout: 5 });
    });

    it('never retries a failure other than 55P03', async () => {
      const orders = migrationSet('orders', ['0000_init']);
      const failure = Object.assign(new Error('deadlock detected'), { code: '40P01' });
      vi.mocked(migrate).mockImplementation(async (_db, config) => {
        if (config.migrationsSchema === 'orders') throw failure;
      });
      const sql = createFakeSql((query) =>
        query.includes('pg_try_advisory_lock') ? [{ locked: true }] : [],
      );
      vi.mocked(postgres).mockReturnValue(sql as never);

      await expect(
        runMigrations(URL, {
          migrations: afterPlatform(orders),
          logger: silentLogger(),
          lockWaitRetryDelayMs: 1,
        }),
      ).rejects.toMatchObject({
        message: `Migration set "orders" (${orders.folder}) failed`,
        cause: failure,
      });
      expect(migrate).toHaveBeenCalledTimes(2); // platform once, orders once
    });
  });

  describe('online steps (OPS-2)', () => {
    const INDEX_A = 'CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_a_idx ON orders.orders (a);';
    const VALIDATE_B = 'ALTER TABLE orders.orders VALIDATE CONSTRAINT orders_b_check;';

    /** A set with one transactional file and an `online/` folder holding `files`. */
    const onlineSet = (name: string, files: Record<string, string>): DatabaseMigrationSet => {
      const set = migrationSet(name, ['0000_init']);
      const onlineFolder = join(set.folder, 'online');
      mkdirSync(onlineFolder);
      for (const [file, text] of Object.entries(files)) {
        writeFileSync(join(onlineFolder, file), text);
      }
      return { ...set, onlineFolder };
    };

    /** The runner's look-up of a set's online bookkeeping table (values: schema, table). */
    const isOnlineLookup = (query: string, values: unknown[]): boolean =>
      query.includes('to_regclass') && values[1] === '__online_migrations';

    /**
     * The migration session of a plain Postgres run: holds the lock, answers the set's online
     * bookkeeping with `recorded` (`null` = no table yet), and logs into `events`.
     */
    const migrationSession = (events: string[], recorded: string[] | null = null) =>
      createFakeSql((query, values) => {
        if (query.includes('pg_try_advisory_lock')) {
          events.push('session: lock');
          return [{ locked: true }];
        }
        if (query.includes('pg_advisory_unlock')) events.push('session: unlock');
        if (isOnlineLookup(query, values)) return [{ exists: recorded !== null }];
        if (query.startsWith('select name from')) {
          return (recorded ?? []).map((name) => ({ name }));
        }
        return [];
      });

    /** The online session: logs each statement; `fail` throws for a statement it matches. */
    const onlineSession = (
      events: string[],
      { invalidIndex, fail }: { invalidIndex?: string; fail?: Error } = {},
    ) =>
      createFakeSql((query, values) => {
        if (query.startsWith('create table if not exists')) events.push('online: bookkeeping');
        else if (query.includes('indisvalid')) {
          events.push(`online: invalid index? ${JSON.stringify(values)}`);
          return invalidIndex === undefined ? [] : [{ index: invalidIndex }];
        } else if (query.startsWith('insert into')) {
          events.push(`online: record ${String(values.at(-1))}`);
        } else {
          events.push(`online: ${query}`);
          if (fail !== undefined && query.startsWith('CREATE')) throw fail;
        }
        return [];
      });

    /** `postgres()` returns `fakes` in order, logging each open. */
    const connections = (events: string[], ...fakes: ReturnType<typeof createFakeSql>[]) => {
      let next = 0;
      vi.mocked(postgres).mockImplementation(((_url: string, options: { connection: object }) => {
        const index = ++next;
        const fake = fakes[index - 1];
        if (fake === undefined) throw new Error('unexpected connection');
        events.push(`open ${JSON.stringify(options.connection)}`);
        fake.end.mockImplementation(async () => {
          events.push(`close ${index}`);
        });
        return fake;
      }) as never);
    };

    it("runs each pending file after its set's migrations (all anchored at its last file), in name order, on a second session opened while the first holds the lock, recording it after it succeeds", async () => {
      const orders = onlineSet('orders', { '0000_a_idx.sql': INDEX_A, '0000_b.sql': VALIDATE_B });
      const audit = migrationSet('audit', ['0000_init']);
      const events: string[] = [];
      vi.mocked(migrate).mockImplementation(async (_db, config) => {
        events.push(`migrate ${config.migrationsSchema ?? ''}`);
      });
      const online = onlineSession(events);
      connections(events, migrationSession(events), online);

      const summary = await runMigrations(URL, {
        migrations: afterPlatform(orders, audit),
        logger: silentLogger(),
        applicationName: 'svc',
      });

      expect(events).toEqual([
        'open {"application_name":"svc:migrate","statement_timeout":"0","lock_timeout":"5000"}',
        'session: lock',
        'migrate app',
        'migrate orders',
        // Default DATABASE_MIGRATION_ONLINE_LOCK_TIMEOUT_MS: 0, wait (a concurrent build that
        // hits a lock timeout is cancelled and leaves an invalid index).
        'open {"application_name":"svc:migrate-online","statement_timeout":"0","lock_timeout":"0"}',
        'online: bookkeeping',
        'online: invalid index? ["orders.orders","orders_a_idx"]',
        `online: ${INDEX_A}`,
        'online: record 0000_a_idx.sql',
        `online: ${VALIDATE_B}`,
        'online: record 0000_b.sql',
        'close 2',
        'migrate audit',
        'session: unlock',
        'close 1',
      ]);
      // The extended protocol, so the server refuses a file holding more than one statement
      // (the simple protocol would run them as one implicit transaction).
      expect(online.unsafe).toHaveBeenCalledWith(INDEX_A, [], { prepare: false, simple: false });
      expect(online.unsafe).toHaveBeenCalledWith(VALIDATE_B, [], { prepare: false, simple: false });
      expect(summary.sets.map((set) => [set.name, set.online])).toEqual([
        ['platform', { total: 0, applied: 0 }],
        ['orders', { total: 2, applied: 2 }],
        ['audit', { total: 0, applied: 0 }],
      ]);
      expect(summary.online).toEqual({ total: 2, applied: 2 });
    });

    it('runs only the files not yet recorded', async () => {
      const orders = onlineSet('orders', { '0000_a_idx.sql': INDEX_A, '0000_b.sql': VALIDATE_B });
      const events: string[] = [];
      connections(events, migrationSession(events, ['0000_a_idx.sql']), onlineSession(events));

      const summary = await runMigrations(URL, {
        migrations: afterPlatform(orders),
        logger: silentLogger(),
        onlineLockTimeoutMs: 250,
      });

      expect(events.filter((event) => event.startsWith('o'))).toEqual([
        'open {"application_name":"app:migrate","statement_timeout":"0","lock_timeout":"5000"}',
        'open {"application_name":"app:migrate-online","statement_timeout":"0","lock_timeout":"250"}',
        'online: bookkeeping',
        `online: ${VALIDATE_B}`,
        'online: record 0000_b.sql',
      ]);
      expect(summary.sets.at(-1)?.online).toEqual({ total: 2, applied: 1 });
    });

    it('opens no second session when every file is recorded', async () => {
      const orders = onlineSet('orders', { '0000_a_idx.sql': INDEX_A });
      const events: string[] = [];
      connections(events, migrationSession(events, ['0000_a_idx.sql']));

      const summary = await runMigrations(URL, {
        migrations: afterPlatform(orders),
        logger: silentLogger(),
      });

      expect(postgres).toHaveBeenCalledTimes(1);
      expect(summary.online).toEqual({ total: 1, applied: 0 });
    });

    describe('at their place in the history (review #4)', () => {
      const TAGS = ['0000_init', '0001_more', '0002_last'];

      /** A set with three transactional files and an `online/` folder holding `files`. */
      const anchoredSet = (files: Record<string, string>): DatabaseMigrationSet => {
        const set = migrationSet('orders', TAGS);
        for (const tag of TAGS) writeFileSync(join(set.folder, `${tag}.sql`), `-- ${tag}`);
        const onlineFolder = join(set.folder, 'online');
        mkdirSync(onlineFolder);
        for (const [file, text] of Object.entries(files)) {
          writeFileSync(join(onlineFolder, file), text);
        }
        return { ...set, onlineFolder };
      };

      /**
       * Logs each `migrate()` of the orders set with the tags its folder's journal lists (read
       * during the call: a truncated copy is removed afterwards), and whether it is the set's own
       * folder; the copies it was given are kept in `copies`.
       */
      const logMigrations = (events: string[], set: DatabaseMigrationSet, copies: string[]) => {
        vi.mocked(migrate).mockImplementation(async (_db, config) => {
          if (config.migrationsSchema !== 'orders') return;
          const journal = JSON.parse(
            readFileSync(join(config.migrationsFolder, 'meta', '_journal.json'), 'utf8'),
          ) as { entries: { tag: string }[] };
          const own = config.migrationsFolder === set.folder;
          if (!own) copies.push(config.migrationsFolder);
          const tags = journal.entries.map((entry) => entry.tag).join(',');
          events.push(`migrate ${own ? 'folder' : 'copy'} [${tags}]`);
        });
      };

      it('on a fresh database, runs each step right after the file it is anchored at: a migrate() per stretch, then the rest', async () => {
        const orders = anchoredSet({ '0000_a_idx.sql': INDEX_A, '0001_b.sql': VALIDATE_B });
        const events: string[] = [];
        const copies: string[] = [];
        logMigrations(events, orders, copies);
        connections(events, migrationSession(events), onlineSession(events), onlineSession(events));

        const summary = await runMigrations(URL, {
          migrations: afterPlatform(orders),
          logger: silentLogger(),
        });

        expect(events.filter((event) => !event.startsWith('online: invalid'))).toEqual([
          'open {"application_name":"app:migrate","statement_timeout":"0","lock_timeout":"5000"}',
          'session: lock',
          'migrate copy [0000_init]',
          'open {"application_name":"app:migrate-online","statement_timeout":"0","lock_timeout":"0"}',
          'online: bookkeeping',
          `online: ${INDEX_A}`,
          'online: record 0000_a_idx.sql',
          'close 2',
          'migrate copy [0000_init,0001_more]',
          'open {"application_name":"app:migrate-online","statement_timeout":"0","lock_timeout":"0"}',
          'online: bookkeeping',
          `online: ${VALIDATE_B}`,
          'online: record 0001_b.sql',
          'close 3',
          'migrate folder [0000_init,0001_more,0002_last]',
          'session: unlock',
          'close 1',
        ]);
        // Each copy is removed after its migrate().
        expect(copies).toHaveLength(2);
        for (const copy of copies) expect(existsSync(copy)).toBe(false);
        expect(summary.sets.at(-1)?.online).toEqual({ total: 2, applied: 2 });
      });

      it('copies the journal as written, only up to the anchor, with the files it lists', async () => {
        const orders = anchoredSet({ '0001_b.sql': VALIDATE_B });
        const entries = TAGS.map((tag, idx) => journalEntry(idx, { tag }));
        writeFileSync(
          join(orders.folder, 'meta', '_journal.json'),
          JSON.stringify({ version: '7', dialect: 'postgresql', entries }),
        );
        const seen: { journal: unknown; files: string[] }[] = [];
        vi.mocked(migrate).mockImplementation(async (_db, config) => {
          if (config.migrationsSchema !== 'orders' || config.migrationsFolder === orders.folder) {
            return;
          }
          seen.push({
            journal: JSON.parse(
              readFileSync(join(config.migrationsFolder, 'meta', '_journal.json'), 'utf8'),
            ),
            files: readdirSync(config.migrationsFolder).toSorted(),
          });
        });
        const events: string[] = [];
        connections(events, migrationSession(events), onlineSession(events));

        await runMigrations(URL, { migrations: afterPlatform(orders), logger: silentLogger() });

        expect(seen).toEqual([
          {
            journal: { version: '7', dialect: 'postgresql', entries: entries.slice(0, 2) },
            files: ['0000_init.sql', '0001_more.sql', 'meta'],
          },
        ]);
      });

      it('runs a step anchored behind the database position (added later, or failed before) first, then the remaining files', async () => {
        const orders = anchoredSet({ '0000_a_idx.sql': INDEX_A, '0001_b.sql': VALIDATE_B });
        const events: string[] = [];
        logMigrations(events, orders, []);
        // The orders set is at 0001: its newest bookkeeping row carries that file's `when`.
        const session = createFakeSql((query, values) => {
          if (query.includes('pg_try_advisory_lock')) return [{ locked: true }];
          if (isOnlineLookup(query, values)) return [{ exists: false }];
          if (!JSON.stringify(values).includes('"orders"')) return [];
          if (query.includes('to_regclass')) return [{ exists: true }];
          if (query.startsWith('select count(*)')) return [{ count: 2 }];
          if (query.includes('max(created_at)')) return [{ latest: String(journalEntry(1).when) }];
          return [];
        });
        connections(events, session, onlineSession(events), onlineSession(events));

        await runMigrations(URL, { migrations: afterPlatform(orders), logger: silentLogger() });

        expect(
          events.filter((event) => event.startsWith('migrate') || event.includes('record')),
        ).toEqual([
          'online: record 0000_a_idx.sql',
          'online: record 0001_b.sql',
          'migrate folder [0000_init,0001_more,0002_last]',
        ]);
      });

      it('never retries an online step that hit its lock_timeout as a set: it fails naming the step', async () => {
        const orders = anchoredSet({ '0000_a_idx.sql': INDEX_A });
        const failure = Object.assign(new Error('canceling statement due to lock timeout'), {
          code: '55P03',
        });
        const events: string[] = [];
        logMigrations(events, orders, []);
        connections(events, migrationSession(events), onlineSession(events, { fail: failure }));

        await expect(
          runMigrations(URL, {
            migrations: afterPlatform(orders),
            logger: silentLogger(),
            onlineLockTimeoutMs: 100,
            lockWaitRetryDelayMs: 1,
          }),
        ).rejects.toMatchObject({
          message: expect.stringMatching(/^Migration set "orders": online step 0000_a_idx\.sql/),
          cause: failure,
        });
        expect(events.filter((event) => event.startsWith('migrate'))).toEqual([
          'migrate copy [0000_init]',
        ]);
        expect(events.filter((event) => event === `online: ${INDEX_A}`)).toHaveLength(1);
      });
    });

    it('a failing file records nothing and stops the run naming the set and the file; both sessions close and the lock is released', async () => {
      const orders = onlineSet('orders', { '0000_a_idx.sql': INDEX_A, '0000_b.sql': VALIDATE_B });
      const audit = migrationSet('audit', ['0000_init']);
      const failure = Object.assign(new Error('could not create unique index'), {
        code: '23505',
      });
      const events: string[] = [];
      vi.mocked(migrate).mockImplementation(async (_db, config) => {
        events.push(`migrate ${config.migrationsSchema ?? ''}`);
      });
      connections(events, migrationSession(events), onlineSession(events, { fail: failure }));

      const error = await runMigrations(URL, {
        migrations: afterPlatform(orders, audit),
        logger: silentLogger(),
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({
        message: expect.stringMatching(
          /^Migration set "orders": online step 0000_a_idx\.sql \(.*0000_a_idx\.sql\) failed; nothing was recorded for it/,
        ) as unknown,
        cause: failure,
      });
      expect(events.slice(-5)).toEqual([
        'online: invalid index? ["orders.orders","orders_a_idx"]',
        `online: ${INDEX_A}`,
        'close 2',
        'session: unlock',
        'close 1',
      ]);
      expect(events).not.toContain('migrate audit');
      expect(events.some((event) => event.startsWith('online: record'))).toBe(false);
    });

    it("drops an invalid index that an earlier run of the file's own CREATE INDEX left, then runs it again", async () => {
      const orders = onlineSet('orders', { '0000_a_idx.sql': INDEX_A });
      const events: string[] = [];
      const logger = silentLogger();
      connections(
        events,
        migrationSession(events),
        onlineSession(events, { invalidIndex: 'orders.orders_a_idx' }),
      );

      await runMigrations(URL, { migrations: afterPlatform(orders), logger });

      expect(events.filter((event) => event.startsWith('online:'))).toEqual([
        'online: bookkeeping',
        'online: invalid index? ["orders.orders","orders_a_idx"]',
        'online: drop index concurrently if exists orders.orders_a_idx',
        `online: ${INDEX_A}`,
        'online: record 0000_a_idx.sql',
      ]);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringMatching(
          /orders: 0000_a_idx\.sql left the invalid index orders\.orders_a_idx/,
        ),
      );
    });

    it.each([
      [
        'a quoted, mixed-case name on ONLY a quoted table, after a comment',
        '-- why\n/* more */ CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "Orders_A" ON ONLY "orders"."Orders" (a)',
        ['"orders"."Orders"', 'Orders_A'],
      ],
      [
        'an unquoted name, folded to lower case like Postgres does',
        'create index concurrently if not exists Orders_B on orders (b)',
        ['orders', 'orders_b'],
      ],
    ])('looks the index up by the name in the statement: %s', async (_label, text, values) => {
      const orders = onlineSet('orders', { '0000_x.sql': text });
      const events: string[] = [];
      connections(events, migrationSession(events), onlineSession(events));

      await runMigrations(URL, { migrations: afterPlatform(orders), logger: silentLogger() });

      expect(events).toContain(`online: invalid index? ${JSON.stringify(values)}`);
    });

    it('looks no index up for a statement that builds none (VALIDATE CONSTRAINT)', async () => {
      const orders = onlineSet('orders', { '0000_b.sql': VALIDATE_B });
      const events: string[] = [];
      connections(events, migrationSession(events), onlineSession(events));

      await runMigrations(URL, { migrations: afterPlatform(orders), logger: silentLogger() });

      expect(events.some((event) => event.includes('invalid index?'))).toBe(false);
    });

    describe('on Citus', () => {
      /**
       * Every connection of a Citus run: the role's default lock_timeout lives in `role.value` and
       * changes on `alter role`; online lookups answer "no table yet".
       */
      const citusConnection = (
        label: string,
        events: string[],
        role: { value: string },
        fail?: Error,
      ) =>
        createFakeSql((query, values) => {
          if (query.includes("extname = 'citus'")) return [{ citus: true }];
          if (query.includes('citus_is_coordinator()')) return [{ coordinator: true }];
          if (query.includes('pg_db_role_setting')) {
            return [{ setconfig: [`lock_timeout=${role.value}`] }];
          }
          if (query.startsWith('alter role')) {
            role.value = /= (\d+)$/.exec(query)?.[1] ?? '?';
            events.push(`${label}: ${query}`);
          }
          if (query.includes('pg_try_advisory_lock')) return [{ locked: true }];
          if (query.includes('pg_advisory_unlock')) events.push(`${label}: unlock`);
          if (isOnlineLookup(query, values)) return [{ exists: false }];
          if (query.startsWith('CREATE')) {
            events.push(`${label}: ${query} (role default ${role.value})`);
            if (fail !== undefined) throw fail;
          }
          return [];
        });

      it('sets the role default to the online timeout on a throwaway connection before the online session opens, and restores the set timeout after it closes', async () => {
        const orders = onlineSet('orders', { '0000_a_idx.sql': INDEX_A });
        const events: string[] = [];
        const role = { value: '5000' };
        connections(
          events,
          citusConnection('preliminary', events, role),
          citusConnection('session', events, role),
          citusConnection('align', events, role),
          citusConnection('toggle', events, role),
          citusConnection('online', events, role),
          citusConnection('restore', events, role),
        );
        const logger = silentLogger();

        await runMigrations(URL, { migrations: afterPlatform(orders), logger });

        expect(events.filter((event) => !event.startsWith('open'))).toEqual([
          'close 1', // preliminary
          'close 3', // alignment under the lock: the role default already equals 5000
          'toggle: alter role current_user set lock_timeout = 0',
          'close 4',
          `online: ${INDEX_A} (role default 0)`,
          'close 5',
          'restore: alter role current_user set lock_timeout = 5000',
          'close 6',
          'session: unlock',
          'close 2',
        ]);
        expect(role.value).toBe('5000');
      });

      it('restores the role default when a file fails, and reports the file', async () => {
        const orders = onlineSet('orders', { '0000_a_idx.sql': INDEX_A });
        const failure = new Error('canceling statement due to user request');
        const events: string[] = [];
        const role = { value: '5000' };
        connections(
          events,
          citusConnection('preliminary', events, role),
          citusConnection('session', events, role),
          citusConnection('align', events, role),
          citusConnection('toggle', events, role),
          citusConnection('online', events, role, failure),
          citusConnection('restore', events, role),
        );

        await expect(
          runMigrations(URL, { migrations: afterPlatform(orders), logger: silentLogger() }),
        ).rejects.toMatchObject({
          message: expect.stringContaining('online step 0000_a_idx.sql') as unknown,
          cause: failure,
        });
        expect(events).toContain('restore: alter role current_user set lock_timeout = 5000');
        expect(role.value).toBe('5000');
      });

      it('leaves the role default alone when the online timeout equals the set timeout', async () => {
        const orders = onlineSet('orders', { '0000_a_idx.sql': INDEX_A });
        const events: string[] = [];
        const role = { value: '5000' };
        connections(
          events,
          citusConnection('preliminary', events, role),
          citusConnection('session', events, role),
          citusConnection('align', events, role),
          citusConnection('online', events, role),
        );

        await runMigrations(URL, {
          migrations: afterPlatform(orders),
          logger: silentLogger(),
          onlineLockTimeoutMs: 5000,
        });

        expect(postgres).toHaveBeenCalledTimes(4);
        expect(events.some((event) => event.includes('alter role'))).toBe(false);
      });

      /** A restore connection that cannot reach the server. */
      const unreachable = (error: Error) =>
        createFakeSql(() => {
          throw error;
        });

      it('keeps the failed step as the error, and logs it, when the restore of the role default fails too', async () => {
        const orders = onlineSet('orders', { '0000_a_idx.sql': INDEX_A });
        const failure = new Error('canceling statement due to user request');
        const restoreError = new Error('connection refused');
        const events: string[] = [];
        const role = { value: '5000' };
        connections(
          events,
          citusConnection('preliminary', events, role),
          citusConnection('session', events, role),
          citusConnection('align', events, role),
          citusConnection('toggle', events, role),
          citusConnection('online', events, role, failure),
          unreachable(restoreError),
        );
        const logger = silentLogger();

        await expect(
          runMigrations(URL, { migrations: afterPlatform(orders), logger }),
        ).rejects.toMatchObject({
          message: expect.stringContaining('online step 0000_a_idx.sql') as unknown,
          cause: failure,
        });
        expect(logger.error).toHaveBeenCalledWith(
          expect.stringMatching(/back to 5000ms after a failed online step: .*connection refused/),
        );
        expect(events).toContain('session: unlock');
      });

      it('fails the run with the restore error when the restore fails after the steps succeeded', async () => {
        const orders = onlineSet('orders', { '0000_a_idx.sql': INDEX_A });
        const restoreError = new Error('connection refused');
        const events: string[] = [];
        const role = { value: '5000' };
        connections(
          events,
          citusConnection('preliminary', events, role),
          citusConnection('session', events, role),
          citusConnection('align', events, role),
          citusConnection('toggle', events, role),
          citusConnection('online', events, role),
          unreachable(restoreError),
        );
        const logger = silentLogger();

        await expect(
          runMigrations(URL, { migrations: afterPlatform(orders), logger }),
        ).rejects.toBe(restoreError);
        expect(logger.error).not.toHaveBeenCalled();
        expect(events).toContain(`online: ${INDEX_A} (role default 0)`);
        expect(events).toContain('session: unlock');
      });
    });

    it.each([
      [
        'a declared folder that does not exist',
        (set: DatabaseMigrationSet) => ({ ...set, onlineFolder: join(set.folder, 'missing') }),
        /Migration set "orders" declares online steps in .*missing, which does not exist/,
      ],
      [
        'a file that is not a numbered .sql file',
        (set: DatabaseMigrationSet) => {
          writeFileSync(join(set.onlineFolder ?? '', 'README.md'), 'notes');
          return set;
        },
        /Migration set "orders": online folder .* holds "README\.md"; only NNNN_<name>\.sql files/,
      ],
      [
        'a file anchored beyond the journal',
        (set: DatabaseMigrationSet) => {
          writeFileSync(join(set.onlineFolder ?? '', '0001_b.sql'), VALIDATE_B);
          return set;
        },
        /Migration set "orders": online step 0001_b\.sql \(.*\) is anchored at 0001, beyond the set's journal \(1 file\(s\), the last is 0000_init\)/,
      ],
      [
        'a file without a statement',
        (set: DatabaseMigrationSet) => {
          writeFileSync(join(set.onlineFolder ?? '', '0001_empty.sql'), '-- nothing yet\n');
          return set;
        },
        /Migration set "orders": online step 0001_empty\.sql .* holds no statement/,
      ],
      [
        'an unnamed concurrent index',
        (set: DatabaseMigrationSet) => {
          writeFileSync(
            join(set.onlineFolder ?? '', '0001_b.sql'),
            'CREATE INDEX CONCURRENTLY ON orders.orders (b);',
          );
          return set;
        },
        /Migration set "orders": online step 0001_b\.sql .* must name its index and say IF NOT EXISTS/,
      ],
      [
        'a concurrent index without IF NOT EXISTS',
        (set: DatabaseMigrationSet) => {
          writeFileSync(
            join(set.onlineFolder ?? '', '0001_b.sql'),
            '/* b */ create unique index concurrently orders_b_key on orders.orders (b);',
          );
          return set;
        },
        /Migration set "orders": online step 0001_b\.sql .* must name its index and say IF NOT EXISTS/,
      ],
    ])('rejects %s before connecting', async (_label, change, message) => {
      const orders = change(onlineSet('orders', { '0000_a_idx.sql': INDEX_A }));
      await expect(
        runMigrations(URL, { migrations: afterPlatform(orders), logger: silentLogger() }),
      ).rejects.toThrow(message);
      expect(postgres).not.toHaveBeenCalled();
    });

    it('rejects an online lock timeout that is not a non-negative integer', async () => {
      await expect(
        runMigrations(URL, {
          migrations: afterPlatform(),
          logger: silentLogger(),
          onlineLockTimeoutMs: -1,
        }),
      ).rejects.toThrow(/onlineLockTimeoutMs must be a non-negative integer \(-1\)/);
      expect(postgres).not.toHaveBeenCalled();
    });
  });
});

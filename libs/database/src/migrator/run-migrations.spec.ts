import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
        { name: 'platform', folder: platformMigrations.folder, total: PLATFORM_TOTAL, applied: 0 },
        { name: 'Orders', folder: orders.folder, total: 1, applied: 1 },
      ],
      total: PLATFORM_TOTAL + 1,
      applied: 1,
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
        },
        { name: 'inventory', folder: inventory.folder, total: 1, applied: 1 },
        { name: 'pricing', folder: pricing.folder, total: 2, applied: 2 },
      ],
      total: PLATFORM_TOTAL + 3,
      applied: PLATFORM_TOTAL + 3,
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

    it('on Citus, a preliminary connection checks the coordinator and aligns the role default, then closes before the migration session opens', async () => {
      const orders = migrationSet('orders', ['0000_init']);
      const events: string[] = [];
      vi.mocked(migrate).mockImplementation(async () => {
        events.push('migrate');
      });
      const preliminary = createFakeSql((query) => {
        if (query.includes("extname = 'citus'")) return [{ citus: true }];
        if (query.includes('citus_is_coordinator()')) {
          events.push('preliminary: coordinator?');
          return [{ coordinator: true }];
        }
        if (query.includes('pg_db_role_setting')) {
          events.push('preliminary: role default?');
          return [{ setconfig: ['search_path=pg_catalog, public', 'lock_timeout=2s'] }];
        }
        if (query.startsWith('alter role')) events.push(`preliminary: ${query}`);
        return [];
      });
      preliminary.end.mockImplementation(async () => {
        events.push('preliminary: closed');
      });
      const session = createFakeSql((query) => {
        if (query.includes('pg_try_advisory_lock')) {
          events.push('session: lock');
          return [{ locked: true }];
        }
        if (query.startsWith('set citus.')) events.push(`session: ${query}`);
        return [];
      });
      vi.mocked(postgres)
        .mockImplementationOnce((() => {
          events.push('open preliminary');
          return preliminary;
        }) as never)
        .mockImplementationOnce((() => {
          events.push('open migration session');
          return session;
        }) as never);
      const logger = silentLogger();

      await runMigrations(URL, {
        migrations: afterPlatform(orders),
        logger,
        lockWaitTimeoutMs: 1500,
      });

      expect(events).toEqual([
        'open preliminary',
        'preliminary: coordinator?',
        'preliminary: role default?',
        'preliminary: alter role current_user set lock_timeout = 1500',
        'preliminary: closed',
        'open migration session',
        'session: lock',
        'session: set citus.enable_local_execution to on',
        "session: set citus.multi_shard_modify_mode to 'sequential'",
        'migrate',
        'migrate',
      ]);
      // Both connections carry the same startup parameters (the 08P01 check runs on the first).
      expect(vi.mocked(postgres).mock.calls.map(([, options]) => options?.connection)).toEqual([
        { application_name: 'app:migrate', statement_timeout: '0', lock_timeout: '1500' },
        { application_name: 'app:migrate', statement_timeout: '0', lock_timeout: '1500' },
      ]);
      expect(session.queries.some((query) => query.includes("extname = 'citus'"))).toBe(false);
      expect(logger.log).toHaveBeenCalledWith(
        expect.stringMatching(/lock_timeout.*1500ms.*was 2s/),
      );
      expect(session.end).toHaveBeenCalledWith({ timeout: 5 });
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
        expect(postgres).toHaveBeenCalledTimes(2);
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
});

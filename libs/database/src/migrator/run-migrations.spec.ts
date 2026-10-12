import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LoggerService } from '@nestjs/common';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeSql } from '../../test/fake-sql.js';
import type { DatabaseMigrationSet } from '../database.types.js';
import { MIGRATIONS_ADVISORY_LOCK_ID, MIGRATIONS_TABLE } from './migrations.constants.js';
import { runMigrations } from './run-migrations.js';

vi.mock('postgres', () => ({ default: vi.fn() }));
// drizzle's migrator itself is exercised by database.int-spec.ts; here only its calls matter.
vi.mock('drizzle-orm/postgres-js/migrator', () => ({ migrate: vi.fn(async () => undefined) }));

const URL = 'postgres://app:app@localhost:5432/app';
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

  /** A set whose folder holds a journal listing `tags`, or no journal at all for `null`. */
  const migrationSet = (name: string, tags: string[] | null): DatabaseMigrationSet => {
    const folder = join(dir, name);
    mkdirSync(join(folder, 'meta'), { recursive: true });
    if (tags !== null) {
      writeFileSync(
        join(folder, 'meta', '_journal.json'),
        JSON.stringify({ entries: tags.map((tag) => ({ tag })) }),
      );
    }
    return { name, folder, migrationsSchema: name, migrationsTable: MIGRATIONS_TABLE };
  };

  it('skips (without connecting) when no set has a drizzle journal yet', async () => {
    const logger = silentLogger();
    const empty = migrationSet('empty', null);
    await expect(runMigrations(URL, { migrations: [empty], logger })).resolves.toEqual({
      sets: [{ name: 'empty', folder: empty.folder, total: 0, applied: 0 }],
      total: 0,
      applied: 0,
    });
    expect(postgres).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('_journal.json missing'));
  });

  it('rejects a malformed journal before connecting', async () => {
    const broken = migrationSet('broken', null);
    writeFileSync(
      join(broken.folder, 'meta', '_journal.json'),
      JSON.stringify({ entries: 'nope' }),
    );
    await expect(
      runMigrations(URL, { migrations: [broken], logger: silentLogger() }),
    ).rejects.toThrow(/Invalid drizzle migration journal/);
    expect(postgres).not.toHaveBeenCalled();
  });

  it('applies the sets in array order on ONE session, under ONE lock, and sums the summary', async () => {
    const identity = migrationSet('identity', ['0000_init']);
    const pending = migrationSet('pending', null);
    const billing = migrationSet('billing', ['0000_init', '0001_more']);
    const appliedBySchema = new Map<string, number>();
    const events: string[] = [];
    vi.mocked(migrate).mockImplementation(async (_db, config) => {
      const schema = config.migrationsSchema ?? '';
      events.push(`migrate ${schema}`);
      appliedBySchema.set(schema, schema === 'billing' ? 2 : 1);
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
      migrations: [identity, pending, billing],
      logger: silentLogger(),
    });

    expect(events).toEqual(['lock', 'migrate identity', 'migrate billing', 'unlock']);
    expect(vi.mocked(migrate).mock.calls.map(([, config]) => config)).toEqual([
      {
        migrationsFolder: identity.folder,
        migrationsSchema: 'identity',
        migrationsTable: MIGRATIONS_TABLE,
      },
      {
        migrationsFolder: billing.folder,
        migrationsSchema: 'billing',
        migrationsTable: MIGRATIONS_TABLE,
      },
    ]);
    expect(summary).toEqual({
      sets: [
        { name: 'identity', folder: identity.folder, total: 1, applied: 1 },
        { name: 'pending', folder: pending.folder, total: 0, applied: 0 },
        { name: 'billing', folder: billing.folder, total: 2, applied: 2 },
      ],
      total: 3,
      applied: 3,
    });
    expect(postgres).toHaveBeenCalledTimes(1);
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
        migrations: [set],
        logger,
        lockTimeoutMs: 30,
        lockPollIntervalMs: 5,
        applicationName: 'svc',
      }),
    ).rejects.toThrow(/Timed out after 30ms waiting for the migrations advisory lock/);

    // single-session client: the lock and migrate() must share one connection that never recycles
    expect(postgres).toHaveBeenCalledWith(
      URL,
      expect.objectContaining({
        max: 1,
        max_lifetime: null,
        connection: { application_name: 'svc:migrate', statement_timeout: 0 },
      }),
    );
    expect(lockValues.length).toBeGreaterThan(1);
    expect(lockValues[0]).toEqual([MIGRATIONS_ADVISORY_LOCK_ID]);
    expect(logger.log).toHaveBeenCalledTimes(1); // "waiting" logged once, not per poll
    expect(migrate).not.toHaveBeenCalled();
    expect(sql.queries.some((q) => q.includes('pg_advisory_unlock'))).toBe(false);
    expect(sql.end).toHaveBeenCalledWith({ timeout: 5 });
  });
});

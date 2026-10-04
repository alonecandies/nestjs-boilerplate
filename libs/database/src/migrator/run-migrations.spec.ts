import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LoggerService } from '@nestjs/common';
import postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeSql } from '../../test/fake-sql.js';
import { MIGRATIONS_ADVISORY_LOCK_ID } from './migrations.constants.js';
import { DEFAULT_MIGRATIONS_FOLDER, runMigrations } from './run-migrations.js';

vi.mock('postgres', () => ({ default: vi.fn() }));

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

  it('defaults to the package migrations folder (src in dev, dist after build)', () => {
    expect(DEFAULT_MIGRATIONS_FOLDER.replaceAll('\\', '/')).toMatch(
      /libs\/database\/src\/migrations$/,
    );
  });

  it('skips (without connecting) when no drizzle journal exists yet', async () => {
    const logger = silentLogger();
    await expect(runMigrations(URL, { migrationsFolder: dir, logger })).resolves.toEqual({
      folder: dir,
      total: 0,
      applied: 0,
    });
    expect(postgres).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('_journal.json missing'));
  });

  it('rejects a malformed journal', async () => {
    mkdirSync(join(dir, 'meta'));
    writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify({ entries: 'nope' }));
    await expect(
      runMigrations(URL, { migrationsFolder: dir, logger: silentLogger() }),
    ).rejects.toThrow(/Invalid drizzle migration journal/);
  });

  it('waits for the advisory lock, then gives up with a clear error and closes the client', async () => {
    mkdirSync(join(dir, 'meta'));
    writeFileSync(
      join(dir, 'meta', '_journal.json'),
      JSON.stringify({ entries: [{ tag: '0000_x' }] }),
    );
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
        migrationsFolder: dir,
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
    expect(sql.queries.some((q) => q.includes('pg_advisory_unlock'))).toBe(false);
    expect(sql.end).toHaveBeenCalledWith({ timeout: 5 });
  });
});

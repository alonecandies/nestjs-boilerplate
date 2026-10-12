import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseMigrationSet } from '../database.types.js';
import { platformMigrations } from '../platform/platform.migrations.js';
import { runMigrationsCli } from './migrate-cli.js';
import { MIGRATIONS_TABLE } from './migrations.constants.js';
import { runMigrations } from './run-migrations.js';

vi.mock('./run-migrations.js', () => ({ runMigrations: vi.fn() }));

const orders: DatabaseMigrationSet = {
  name: 'orders',
  folder: '/migrations/orders',
  migrationsSchema: 'orders',
  migrationsTable: MIGRATIONS_TABLE,
};

describe('runMigrationsCli', () => {
  afterEach(() => {
    process.exitCode = undefined; // never leak a failure code into the test worker
    vi.unstubAllEnvs();
  });

  it("applies the platform set, then the app's sets, and logs one JSON summary line", async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://app:app@db:5432/app');
    vi.stubEnv('SERVICE_NAME', 'orders-service');
    vi.stubEnv('LOG_PRETTY', 'false');
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.mocked(runMigrations).mockResolvedValue({
      sets: [
        { name: 'platform', folder: platformMigrations.folder, total: 1, applied: 1 },
        { name: 'orders', folder: orders.folder, total: 2, applied: 2 },
      ],
      total: 3,
      applied: 3,
    });

    await runMigrationsCli([orders], []);

    expect(runMigrations).toHaveBeenCalledWith(
      'postgres://app:app@db:5432/app',
      expect.objectContaining({
        migrations: [platformMigrations, orders],
        applicationName: 'orders-service',
      }),
    );
    expect(JSON.parse(String(out.mock.calls.at(-1)?.[0]))).toMatchObject({
      level: 'log',
      message: 'Done: 3 applied, 3 total (platform, orders)',
    });
    expect(process.exitCode).toBeUndefined();
  });

  it('exits 1 on an unknown flag, before touching the database', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await runMigrationsCli([orders], ['--migrations-folder', 'x']);
    expect(runMigrations).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(String(err.mock.calls[0]?.[0])).toContain('--migrations-folder');
  });

  it('exits 1 when the app lists the platform set itself', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await runMigrationsCli([platformMigrations], []);
    expect(runMigrations).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(String(err.mock.calls[0]?.[0])).toContain('listed twice');
  });
});

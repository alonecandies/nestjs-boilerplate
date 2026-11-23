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
    vi.stubEnv('DATABASE_URL', 'postgres://app_runtime:r@pgbouncer:6432/app');
    vi.stubEnv('DATABASE_MIGRATION_URL', 'postgres://app:app@db:5432/app');
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

  it('bounds lock waits with DATABASE_MIGRATION_LOCK_TIMEOUT_MS and DATABASE_MIGRATION_LOCK_RETRIES', async () => {
    vi.stubEnv('DATABASE_MIGRATION_URL', 'postgres://app:app@db:5432/app');
    vi.stubEnv('LOG_PRETTY', 'false');
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.mocked(runMigrations).mockResolvedValue({ sets: [], total: 0, applied: 0 });

    vi.stubEnv('DATABASE_MIGRATION_LOCK_TIMEOUT_MS', '750');
    vi.stubEnv('DATABASE_MIGRATION_LOCK_RETRIES', '2');
    await runMigrationsCli([orders], []);
    expect(runMigrations).toHaveBeenLastCalledWith(
      'postgres://app:app@db:5432/app',
      expect.objectContaining({ lockWaitTimeoutMs: 750, lockWaitRetries: 2 }),
    );

    vi.stubEnv('DATABASE_MIGRATION_LOCK_TIMEOUT_MS', '');
    vi.stubEnv('DATABASE_MIGRATION_LOCK_RETRIES', '');
    await runMigrationsCli([orders], []);
    expect(runMigrations).toHaveBeenLastCalledWith(
      'postgres://app:app@db:5432/app',
      expect.objectContaining({ lockWaitTimeoutMs: 5000, lockWaitRetries: 5 }),
    );
    expect(process.exitCode).toBeUndefined();
  });

  it('a production release job needs no DATABASE_SYSTEM_URL (it never opens the system pool)', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DATABASE_URL', 'postgres://app_runtime:r@pgbouncer:6432/app?sslmode=verify-full');
    vi.stubEnv('DATABASE_SYSTEM_URL', '');
    vi.stubEnv('DATABASE_MIGRATION_URL', 'postgres://app_owner:o@db:5432/app?sslmode=verify-full');
    vi.stubEnv('JWT_ACCESS_SECRET', 'a-production-access-secret-of-at-least-32-chars');
    vi.stubEnv('LOG_PRETTY', 'false');
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.mocked(runMigrations).mockResolvedValue({ sets: [], total: 0, applied: 0 });

    await runMigrationsCli([orders], []);

    expect(err.mock.calls.map((call) => String(call[0])).join('\n')).toBe('');
    expect(runMigrations).toHaveBeenCalledWith(
      'postgres://app_owner:o@db:5432/app?sslmode=verify-full',
      expect.anything(),
    );
    expect(process.exitCode).toBeUndefined();
  });

  it('a production release job still refuses a migration URL without TLS', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DATABASE_URL', 'postgres://app_runtime:r@pgbouncer:6432/app?sslmode=verify-full');
    vi.stubEnv('DATABASE_SYSTEM_URL', '');
    vi.stubEnv('DATABASE_MIGRATION_URL', 'postgres://app_owner:o@db:5432/app');
    vi.stubEnv('LOG_PRETTY', 'false');
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await runMigrationsCli([orders], []);
    expect(runMigrations).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    const logged = err.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain('DATABASE_MIGRATION_URL');
    expect(logged).not.toContain('DATABASE_SYSTEM_URL');
  });

  it('exits 1 naming DATABASE_MIGRATION_URL when it is missing, opening no connection', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://app_runtime:r@pgbouncer:6432/app');
    vi.stubEnv('DATABASE_MIGRATION_URL', '');
    vi.stubEnv('LOG_PRETTY', 'false');
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await runMigrationsCli([orders], []);
    expect(runMigrations).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    const logged = err.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain('DATABASE_MIGRATION_URL');
    expect(logged).not.toContain('pgbouncer:6432');
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

import { describe, expect, it } from 'vitest';
import { databaseConfig, databaseMigrationEnvSchema } from './database.config.js';

describe('database namespace: migration lock waits (OPS-2)', () => {
  it('defaults to a 5 s lock_timeout and 5 retries, for the app and the migrate job alike', () => {
    expect(databaseConfig.parse({})).toMatchObject({
      migrationLockTimeoutMs: 5000,
      migrationLockRetries: 5,
    });
    expect(databaseMigrationEnvSchema.parse({})).toMatchObject({
      migrationLockTimeoutMs: 5000,
      migrationLockRetries: 5,
    });
  });

  it('reads both variables; 0 disables the timeout or the retries', () => {
    expect(
      databaseConfig.parse({
        DATABASE_MIGRATION_LOCK_TIMEOUT_MS: '500',
        DATABASE_MIGRATION_LOCK_RETRIES: '1',
      }),
    ).toMatchObject({ migrationLockTimeoutMs: 500, migrationLockRetries: 1 });
    expect(
      databaseConfig.parse({
        DATABASE_MIGRATION_LOCK_TIMEOUT_MS: '0',
        DATABASE_MIGRATION_LOCK_RETRIES: '0',
      }),
    ).toMatchObject({ migrationLockTimeoutMs: 0, migrationLockRetries: 0 });
  });

  it.each([
    ['DATABASE_MIGRATION_LOCK_TIMEOUT_MS', '-1'],
    ['DATABASE_MIGRATION_LOCK_TIMEOUT_MS', '1.5'],
    ['DATABASE_MIGRATION_LOCK_RETRIES', '-1'],
    ['DATABASE_MIGRATION_LOCK_RETRIES', '101'],
  ])('rejects %s=%s', (key, value) => {
    expect(() => databaseConfig.parse({ [key]: value })).toThrow(key);
  });
});

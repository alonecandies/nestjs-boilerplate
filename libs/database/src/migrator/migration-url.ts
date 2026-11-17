import type { DatabaseConfig } from '@platform/config';

/**
 * The URL every migration run connects with: `DATABASE_MIGRATION_URL` (the `app_owner` role,
 * directly to the coordinator; the runner's session advisory lock is wrong behind PgBouncer).
 * There is no fallback to `DATABASE_URL`: the runtime role must never run DDL, so a missing value
 * throws here, before any connection opens.
 */
export function requireMigrationUrl(cfg: Pick<DatabaseConfig, 'migrationUrl'>): string {
  if (cfg.migrationUrl === undefined) {
    throw new Error(
      'DATABASE_MIGRATION_URL is not set: migrations connect as the app_owner role directly to the coordinator, never over DATABASE_URL',
    );
  }
  return cfg.migrationUrl;
}

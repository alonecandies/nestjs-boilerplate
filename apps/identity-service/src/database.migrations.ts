import { identityMigrations } from '@domain/identity';
import type { DatabaseMigrationSet } from '@platform/database';

/**
 * The Postgres migration sets identity-service owns (`platformMigrations` always runs first).
 * One list for both paths: `AppModule` at boot (DATABASE_RUN_MIGRATIONS) and `migrate.ts`.
 */
export const DATABASE_MIGRATIONS: readonly DatabaseMigrationSet[] = [identityMigrations];

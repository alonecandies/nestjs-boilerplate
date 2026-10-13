import { join } from 'node:path';
import type { DatabaseMigrationSet } from '../database.types.js';
import { MIGRATIONS_TABLE } from '../migrator/migrations.constants.js';

/**
 * The platform migration set: the SQL no domain owns. It creates the `app` schema (bookkeeping in
 * `app.__drizzle_migrations`; B3 adds the RLS helper functions there) and the extensions domain
 * tables rely on (pg_trgm). Always applied first, under the same advisory lock as the domain sets
 * (`withPlatformMigrations`). The files are hand-written, see the README "Platform migration set".
 * `folder` resolves to src/ in dev and dist/ after the build (SWC copyFiles ships .sql and meta/).
 */
export const platformMigrations: DatabaseMigrationSet = {
  name: 'platform',
  folder: join(import.meta.dirname, 'migrations'),
  migrationsSchema: 'app',
  migrationsTable: MIGRATIONS_TABLE,
};

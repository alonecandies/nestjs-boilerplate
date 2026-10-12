import { join } from 'node:path';
import { type DatabaseMigrationSet, MIGRATIONS_TABLE } from '@platform/database';
import { identityPgSchema } from './identity.schema.js';

/**
 * Identity's own Postgres migration history: ./migrations, generated from identity.schema.ts by
 * ../../../drizzle.config.ts, bookkeeping in `identity.__drizzle_migrations`. Apps that own
 * identity's tables list it in `DatabaseModule.forRootAsync({ migrations })` and in their
 * `migrate.ts`; the platform set always runs before it. src/ in dev, dist/ after the build.
 */
export const identityMigrations: DatabaseMigrationSet = {
  name: 'identity',
  folder: join(import.meta.dirname, 'migrations'),
  migrationsSchema: identityPgSchema.schemaName,
  migrationsTable: MIGRATIONS_TABLE,
};

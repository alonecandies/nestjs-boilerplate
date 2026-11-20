import { join } from 'node:path';
import { type DatabaseMigrationSet, MIGRATIONS_TABLE } from '@platform/database';
import { aiPgSchema } from './ai.schema.js';

/**
 * The ai context's own Postgres migration history: ./migrations, generated from ai.schema.ts by
 * ../../../drizzle.config.ts, bookkeeping in `ai.__drizzle_migrations`. Apps that own the ai tables
 * list it in `DatabaseModule.forRootAsync({ migrations })` and in their `migrate.ts`; the platform
 * set always runs before it. src/ in dev, dist/ after the build.
 */
export const aiMigrations: DatabaseMigrationSet = {
  name: 'ai',
  folder: join(import.meta.dirname, 'migrations'),
  migrationsSchema: aiPgSchema.schemaName,
  migrationsTable: MIGRATIONS_TABLE,
};

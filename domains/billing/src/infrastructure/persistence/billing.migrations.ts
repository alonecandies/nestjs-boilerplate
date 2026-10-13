import { join } from 'node:path';
import { type DatabaseMigrationSet, MIGRATIONS_TABLE } from '@platform/database';
import { billingPgSchema } from './billing.schema.js';

/**
 * Billing's own Postgres migration history: ./migrations, generated from billing.schema.ts by
 * ../../../drizzle.config.ts, bookkeeping in `billing.__drizzle_migrations`. Apps that own
 * billing's tables list it in `DatabaseModule.forRootAsync({ migrations })` and in their
 * `migrate.ts`; the platform set always runs before it. src/ in dev, dist/ after the build.
 */
export const billingMigrations: DatabaseMigrationSet = {
  name: 'billing',
  folder: join(import.meta.dirname, 'migrations'),
  migrationsSchema: billingPgSchema.schemaName,
  migrationsTable: MIGRATIONS_TABLE,
};

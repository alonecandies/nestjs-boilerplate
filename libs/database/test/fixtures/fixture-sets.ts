import { join } from 'node:path';
import type { DatabaseMigrationSet } from '../../src/database.types.js';
import { MIGRATIONS_TABLE } from '../../src/migrator/migrations.constants.js';

/** drizzle-kit output of widgets.schema.ts (README "Tests"), bookkeeping in public.__drizzle_migrations. */
export const widgetsMigrations: DatabaseMigrationSet = {
  name: 'widgets',
  folder: join(import.meta.dirname, 'migrations'),
  migrationsSchema: 'public',
  migrationsTable: MIGRATIONS_TABLE,
};

/**
 * A second, hand-written history whose journal `when` is OLDER than every widgets entry. It is
 * applied only because it has its own bookkeeping table: drizzle skips files older than the last
 * row of the table it writes to.
 */
export const gadgetsMigrations: DatabaseMigrationSet = {
  name: 'gadgets',
  folder: join(import.meta.dirname, 'gadgets', 'migrations'),
  migrationsSchema: 'gadgets',
  migrationsTable: MIGRATIONS_TABLE,
};

/**
 * A hand-written, Citus-shaped history: an enum, a reference table and two colocated tenant tables,
 * then their foreign keys, in one file (one transaction). It calls the platform set's helpers, so it
 * runs after platformMigrations; on plain Postgres the helpers are no-ops and the tables stay local.
 */
export const catalogMigrations: DatabaseMigrationSet = {
  name: 'catalog',
  folder: join(import.meta.dirname, 'citus', 'migrations'),
  migrationsSchema: 'catalog',
  migrationsTable: MIGRATIONS_TABLE,
};

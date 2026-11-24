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

/**
 * The boot guard fixture (B3 Task 8): one tenant-distributed table under forced RLS, in its own
 * schema with its own bookkeeping table. Runs after platformMigrations (it calls its helpers).
 */
export const guardedMigrations: DatabaseMigrationSet = {
  name: 'guarded',
  folder: join(import.meta.dirname, 'guarded', 'migrations'),
  migrationsSchema: 'guarded',
  migrationsTable: MIGRATIONS_TABLE,
};

/**
 * The sharding smoke fixture (B3 Task 18): a reference table and a tenant-distributed table under
 * forced RLS, with policies that call `app.user_id()`. Runs after platformMigrations.
 */
export const shardingMigrations: DatabaseMigrationSet = {
  name: 'sharding',
  folder: join(import.meta.dirname, 'sharding', 'migrations'),
  migrationsSchema: 'sharding',
  migrationsTable: MIGRATIONS_TABLE,
};

/**
 * The lock-wait fixture (OPS-2): one hand-written file that alters the widgets table (so it runs
 * after widgetsMigrations), with its own bookkeeping table. An open transaction that read widgets
 * blocks its ALTER, which is what the migration session's lock_timeout must cut short.
 */
export const lockWaitMigrations: DatabaseMigrationSet = {
  name: 'lock-wait',
  folder: join(import.meta.dirname, 'lock-wait', 'migrations'),
  migrationsSchema: 'lock_wait',
  migrationsTable: MIGRATIONS_TABLE,
};

/**
 * The online-steps fixture (OPS-2): a tenant table (distributed on Citus) in its own schema, and an
 * `online/` folder inside its migrations folder with one `CREATE INDEX CONCURRENTLY`. Runs after platformMigrations (it calls
 * its helpers). `gizmosTablesMigrations` is the same set without online steps.
 */
export const gizmosTablesMigrations: DatabaseMigrationSet = {
  name: 'gizmos',
  folder: join(import.meta.dirname, 'gizmos', 'migrations'),
  migrationsSchema: 'gizmos',
  migrationsTable: MIGRATIONS_TABLE,
};

export const gizmosMigrations: DatabaseMigrationSet = {
  ...gizmosTablesMigrations,
  onlineFolder: join(import.meta.dirname, 'gizmos', 'migrations', 'online'),
};

/**
 * The lock-wait fixture on a distributed table (B1-7): one hand-written file that alters
 * gizmos.gizmos (so it runs after gizmosTablesMigrations), with its own bookkeeping table. On a
 * coordinator plus worker, its ALTER reaches the shards over connections the coordinator opens to
 * the worker, so an open transaction that read one shard there blocks it.
 */
export const gizmosLockWaitMigrations: DatabaseMigrationSet = {
  name: 'gizmos-lock-wait',
  folder: join(import.meta.dirname, 'gizmos-lock-wait', 'migrations'),
  migrationsSchema: 'gizmos_lock_wait',
  migrationsTable: MIGRATIONS_TABLE,
};

/** The gizmos set with another online folder of `fixtures/gizmos` (`online-retry`, …) instead. */
export const gizmosWithOnline = (folder: string): DatabaseMigrationSet => ({
  ...gizmosTablesMigrations,
  onlineFolder: join(import.meta.dirname, 'gizmos', folder),
});

/**
 * The anchored-steps fixture (review #4): transactional 0000 creates a table, the online step
 * `0000_anchored_code_key.sql` (anchored at 0000) builds a unique index concurrently, and
 * transactional 0001 turns that index into a constraint (`UNIQUE USING INDEX`), so 0001 needs the
 * online step to have run before it. `anchoredAt0000` is the same set as of 0000: its folder's
 * journal stops there, with the same online folder (the database a release with only 0000 left).
 */
export const anchoredMigrations: DatabaseMigrationSet = {
  name: 'anchored',
  folder: join(import.meta.dirname, 'anchored', 'migrations'),
  migrationsSchema: 'anchored',
  migrationsTable: MIGRATIONS_TABLE,
  onlineFolder: join(import.meta.dirname, 'anchored', 'migrations', 'online'),
};

export const anchoredAt0000: DatabaseMigrationSet = {
  ...anchoredMigrations,
  folder: join(import.meta.dirname, 'anchored', 'at-0000'),
};

/*
 * Shared by the runtime migrator AND drizzle.config.ts (drizzle-kit loads that file with its own
 * loader) — so this file must stay dependency-free.
 */

/** Bookkeeping table drizzle writes applied migrations to. Must equal drizzle.config `migrations`. */
export const MIGRATIONS_SCHEMA = 'public';
export const MIGRATIONS_TABLE = '__drizzle_migrations';

/**
 * App-wide constant key for `pg_advisory_lock(bigint)`: drizzle's `migrate()` takes no lock, so
 * concurrent replicas booting with DATABASE_RUN_MIGRATIONS=true would race without it.
 */
export const MIGRATIONS_ADVISORY_LOCK_ID = 727_001;

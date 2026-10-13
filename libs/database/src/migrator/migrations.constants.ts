/** Name of every set's bookkeeping table; each set keeps it in its own schema (`<schema>.__drizzle_migrations`). */
export const MIGRATIONS_TABLE = '__drizzle_migrations';

/**
 * App-wide constant key for `pg_advisory_lock(bigint)`: drizzle's `migrate()` takes no lock, so
 * concurrent replicas booting with DATABASE_RUN_MIGRATIONS=true would race without it. One key for
 * every set, so processes that share a database (identity-service and billing-service) migrate one
 * after the other.
 */
export const MIGRATIONS_ADVISORY_LOCK_ID = 727_001;

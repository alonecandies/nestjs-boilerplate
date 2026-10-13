import type { PgTransactionConfig } from 'drizzle-orm/pg-core';
import type { DrizzleSchema } from './drizzle/drizzle.types.js';
import type { PostgresOptions } from './drizzle/postgres-options.js';

/** `@nestjs-cls/transactional` plugin settings registered by `DatabaseModule`. */
export interface DatabaseTransactionalOptions {
  /** Merged into every `@Transactional()` / `txHost.withTransaction()` call. */
  defaultTxOptions?: PgTransactionConfig;
  /** Also provide `@InjectTransaction()` (a proxy to the active tx). Default `false`. */
  enableTransactionProxy?: boolean;
}

/**
 * One migration history: a drizzle-kit output folder plus its OWN bookkeeping table. Each domain
 * exports one (`identityMigrations`, `billingMigrations`); `platformMigrations` always runs first.
 */
export interface DatabaseMigrationSet {
  /** Label in logs and run summaries; unique within one process. */
  readonly name: string;
  /** `meta/_journal.json` + `NNNN_*.sql`, resolved from `import.meta.dirname` (src or dist). */
  readonly folder: string;
  /** Schema of the bookkeeping table `<migrationsSchema>.<migrationsTable>`, never shared. */
  readonly migrationsSchema: string;
  readonly migrationsTable: string;
}

export interface DatabaseModuleOptions<TSchema extends DrizzleSchema = DrizzleSchema> {
  /**
   * Drizzle schema (tables + relations) — enables the typed relational API (`db.query.users…`).
   * Merge several domains' schemas in the monolith: `{ ...identitySchema, ...billingSchema }`.
   */
  schema: TSchema;
  /**
   * The domain migration sets this process owns, in order. Applied after `platformMigrations`
   * (always first, never listed here) under one advisory lock when `runMigrations` /
   * DATABASE_RUN_MIGRATIONS is on. `[]` when the process owns no tables.
   */
  migrations: readonly DatabaseMigrationSet[];
  /** Overrides `DATABASE_RUN_MIGRATIONS`. */
  runMigrations?: boolean;
  /**
   * Registers `ClsPluginTransactional` (Drizzle adapter) so `@Transactional()` / `TransactionHost`
   * work app-wide. Default `true`; pass `false` if the app registers its own plugin.
   */
  transactional?: boolean | DatabaseTransactionalOptions;
  /** Deep-merged over the config-derived postgres.js options (TLS objects, tests…). */
  postgres?: PostgresOptions;
}

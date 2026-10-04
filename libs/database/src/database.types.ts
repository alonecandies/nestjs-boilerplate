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

export interface DatabaseModuleOptions<TSchema extends DrizzleSchema = DrizzleSchema> {
  /**
   * Drizzle schema (tables + relations) — enables the typed relational API (`db.query.users…`).
   * Merge several domains' schemas in the monolith: `{ ...identitySchema, ...billingSchema }`.
   */
  schema: TSchema;
  /** drizzle-kit output folder to apply on boot. Default: this package's `migrations` folder. */
  migrationsFolder?: string;
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

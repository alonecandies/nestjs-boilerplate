/**
 * @app/database — PostgreSQL for the whole monorepo: postgres.js pool + Drizzle ORM (global
 * `DatabaseModule`), CLS-propagated transactions (`@Transactional()`), drizzle-kit migrations
 * with an advisory-locked runner (boot or `migrate.ts` CLI), a readiness contributor and
 * uuidv7 keyset-pagination helpers. Domain `*.schema.ts` files live in the domain libs.
 */

/*
 * Convenience re-exports so domain code depends on "our" transaction API, not on the CLS library
 * directly (same single package instance either way).
 */
export {
  InjectTransaction,
  InjectTransactionHost,
  Propagation,
  Transactional,
  TransactionHost,
} from '@nestjs-cls/transactional';
export * from './database.module.js';
export * from './database.types.js';
export * from './drizzle/drizzle.constants.js';
export * from './drizzle/drizzle.factory.js';
export * from './drizzle/drizzle.types.js';
export * from './drizzle/drizzle-query.logger.js';
export * from './drizzle/drizzle-transactional.adapter.js';
export * from './drizzle/inject-drizzle.decorator.js';
export * from './drizzle/postgres-options.js';
export * from './health/database.health.js';
export * from './migrator/migrations.constants.js';
export * from './migrator/run-migrations.js';
export * from './pagination/keyset.js';

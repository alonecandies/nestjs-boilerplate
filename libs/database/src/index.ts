/**
 * @platform/database — PostgreSQL for the whole monorepo: postgres.js pool + Drizzle ORM (global
 * `DatabaseModule`), CLS-propagated transactions (`@Transactional()`), migration sets (the
 * platform set first, then each domain's own drizzle-kit history) applied by an advisory-locked
 * runner at boot or by each app's `migrate.ts` (`runMigrationsCli`), a readiness contributor and
 * uuidv7 keyset-pagination helpers. Every runtime transaction opens with the RLS context of the CLS
 * principal (`SET LOCAL`, refused without one); repositories reach it through `inUnitOfWork`, and
 * `RlsElevation` turns `app.elevated` on inside it (after a permission check, or a justified reason).
 * Principal-less work (in `SystemContext`, or `pre-auth` lookups) goes through `SystemDatabase`, the
 * only door to the `app_system` pool on DATABASE_SYSTEM_URL, by named system methods.
 * Domain `*.schema.ts` files and histories live in the domains.
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
// The boot guard's contract only: its checks and runner stay package-internal.
export { type BootGuardFinding, DatabaseBootGuardError } from './boot/boot-guard.js';
export * from './database.module.js';
export * from './database.types.js';
export * from './drizzle/drizzle.constants.js';
// The runtime pool builder only: the system pool is reachable through SystemDatabase alone, and
// the boot guard runs inside DatabaseModule.
export { createDrizzleDatabase } from './drizzle/drizzle.factory.js';
export * from './drizzle/drizzle.types.js';
export * from './drizzle/drizzle-query.logger.js';
export * from './drizzle/drizzle-transactional.adapter.js';
export * from './drizzle/inject-drizzle.decorator.js';
export * from './drizzle/pool-usage.js';
export * from './drizzle/postgres-options.js';
export * from './health/database.health.js';
export * from './migrator/migrate-cli.js';
export * from './migrator/migration-sets.js';
export * from './migrator/migrations.constants.js';
export * from './migrator/run-migrations.js';
export * from './pagination/keyset.js';
export * from './platform/platform.migrations.js';
// The RLS contract only: the applied-context recorder and comparison stay package-internal.
export {
  buildRlsContextSql,
  getAppliedRlsContext,
  RLS_UUID_PATTERN,
  RlsContextError,
  type RlsContextInput,
  type RlsErrorCode,
  rlsContextOf,
} from './rls/rls-context.js';
export {
  DB_RLS_ELEVATIONS_TOTAL,
  ELEVATION_DENIED,
  ELEVATION_REASONS,
  type ElevationReason,
  RlsElevation,
} from './rls/rls-elevation.service.js';
export * from './rls/row-count.js';
export * from './rls/unit-of-work.js';
// The system pool's contract only: its raw handle (SYSTEM_POOL) and pool builder stay internal.
export {
  DB_SYSTEM_CALLS_TOTAL,
  InjectSystemDatabase,
  SYSTEM_DATABASE,
  SystemDatabase,
  SystemDatabaseError,
  type SystemDatabaseErrorCode,
} from './system/system-database.js';
export {
  defineSystemMethod,
  type SystemMethod,
  type SystemMethodScope,
} from './system/system-method.js';

import { Logger } from '@nestjs/common';
import { retry } from '@platform/common';
import type { AppConfig, DatabaseConfig } from '@platform/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import { runBootGuard } from '../boot/boot-guard.js';
import type { DatabaseModuleOptions } from '../database.types.js';
import { withPlatformMigrations } from '../migrator/migration-sets.js';
import { requireMigrationUrl } from '../migrator/migration-url.js';
import { runMigrations } from '../migrator/run-migrations.js';
import type { DrizzleDB, DrizzleSchema } from './drizzle.types.js';
import { DrizzleQueryLogger } from './drizzle-query.logger.js';
import { PoolUsage, registerPoolUsage } from './pool-usage.js';
import {
  buildPostgresOptions,
  describePostgresUrl,
  isTransientConnectionError,
} from './postgres-options.js';
import { preferPreparedStatements } from './prepared-statements.js';

/** Boot connectivity retries (DB container still starting, failover in progress). */
const BOOT_PING_RETRIES = 4;

/**
 * Builds the pool + Drizzle handle used by `DatabaseModule` (exported for scripts/tests that run
 * outside Nest). Order matters:
 * 1. migrations (own single-connection client + advisory lock, on DATABASE_MIGRATION_URL: the
 *    owner role, direct to the coordinator; missing → throws before any connection) so the app
 *    never serves traffic against an outdated schema;
 * 2. pool + `select 1` with a short retry on transient connection errors → fail fast at boot
 *    (and warm one connection) instead of on the first request.
 */
export async function createDrizzleDatabase<TSchema extends DrizzleSchema>(
  cfg: DatabaseConfig,
  app: AppConfig,
  options: DatabaseModuleOptions<TSchema>,
  logger: Logger = new Logger('DatabaseModule'),
): Promise<DrizzleDB<TSchema>> {
  const target = describePostgresUrl(cfg.url);
  if (options.runMigrations ?? cfg.runMigrations) {
    // The platform set first, then the app's domain sets in order, all under one advisory lock.
    await runMigrations(requireMigrationUrl(cfg), {
      migrations: withPlatformMigrations(options.migrations),
      logger,
      applicationName: app.serviceName,
      // Bounded lock waits, as in the release job (DATABASE_MIGRATION_LOCK_*).
      lockWaitTimeoutMs: cfg.migrationLockTimeoutMs,
      lockWaitRetries: cfg.migrationLockRetries,
    });
  }

  const client = postgres(
    cfg.url,
    buildPostgresOptions(
      cfg,
      {
        applicationName: app.serviceName,
        onNotice: (notice) => logger.debug(`NOTICE ${notice['message'] ?? ''}`),
      },
      options.postgres,
    ),
  );
  // db_pool_*{pool="runtime"}: postgres.js has no pool statistics, so operations are counted.
  const db = openDrizzle(client, new PoolUsage('runtime', cfg.poolMax), cfg, app, options);
  await warmUp(client, target, logger);
  logger.log(`Postgres pool ready: ${target} (max ${cfg.poolMax}, prepare ${cfg.prepare})`);
  return db;
}

/**
 * The second pool, on DATABASE_SYSTEM_URL (`app_system`, BYPASSRLS), for `SystemDatabase` only
 * (B3-10): `max = systemPoolMax` (at most 5) even when `options.postgres` sets one, an
 * `application_name` ending in `:system`, never registered with the CLS transaction host.
 * Returns `null` without DATABASE_SYSTEM_URL: there is then no system pool, and no fallback to
 * DATABASE_URL. Warmed like the runtime pool. Package-internal (`DatabaseModule` wires it).
 */
export async function createSystemDrizzleDatabase<TSchema extends DrizzleSchema>(
  cfg: DatabaseConfig,
  app: AppConfig,
  options: DatabaseModuleOptions<TSchema>,
  logger: Logger = new Logger('DatabaseModule'),
): Promise<DrizzleDB<TSchema> | null> {
  if (cfg.systemUrl === undefined || cfg.systemUrl === '') return null;
  const target = describePostgresUrl(cfg.systemUrl);
  const client = postgres(cfg.systemUrl, {
    ...buildPostgresOptions(
      cfg,
      {
        applicationName: app.serviceName,
        onNotice: (notice) => logger.debug(`NOTICE ${notice['message'] ?? ''}`),
        pool: 'system',
      },
      options.postgres,
    ),
    max: cfg.systemPoolMax,
  });
  // db_pool_*{pool="system"} (G-8).
  const db = openDrizzle(client, new PoolUsage('system', cfg.systemPoolMax), cfg, app, options);
  await warmUp(client, target, logger);
  logger.log(`Postgres system pool ready: ${target} (max ${cfg.systemPoolMax})`);
  return db;
}

/**
 * The boot guard (B3-14, SH-10) on the open pools: `runtime` (DRIZZLE) and `system` (or `null`),
 * over the platform set and `options.migrations`, in `cfg.bootGuard` mode. Throws
 * `DatabaseBootGuardError` in `enforce` when anything is found; the caller ends the pools.
 * Package-internal (`DatabaseModule` runs it once both pools are open).
 */
export async function guardDatabasePools<TSchema extends DrizzleSchema>(
  cfg: DatabaseConfig,
  options: DatabaseModuleOptions<TSchema>,
  runtime: DrizzleDB<TSchema>,
  system: DrizzleDB<TSchema> | null,
  logger: Logger = new Logger('DatabaseModule'),
): Promise<void> {
  await runBootGuard(
    cfg.bootGuard,
    {
      runtime: runtime.$client,
      system: system?.$client ?? null,
      sets: withPlatformMigrations(options.migrations),
    },
    logger,
  );
}

/** Drizzle over `client`, its operations counted in `usage` (published as `db_pool_*{pool}`). */
function openDrizzle<TSchema extends DrizzleSchema>(
  client: Sql,
  usage: PoolUsage,
  cfg: DatabaseConfig,
  app: AppConfig,
  options: DatabaseModuleOptions<TSchema>,
): DrizzleDB<TSchema> {
  registerPoolUsage(usage);
  return drizzle({
    // drizzle runs every query through `unsafe()`, which postgres.js never prepares by default.
    client: preferPreparedStatements(usage.track(client)),
    schema: options.schema,
    // MUST equal drizzle.config.ts `casing` (drizzle-kit) or generated SQL and queries disagree.
    casing: 'snake_case',
    logger: cfg.logQueries ? new DrizzleQueryLogger({ logParams: !app.isProduction }) : false,
  });
}

/** `select 1` with a short retry on transient errors; ends the pool (no wait) when it fails. */
async function warmUp(client: Sql, target: string, logger: Logger): Promise<void> {
  try {
    await retry(
      async () => {
        await client`select 1`;
      },
      {
        retries: BOOT_PING_RETRIES,
        minDelayMs: 250,
        maxDelayMs: 4_000,
        shouldRetry: isTransientConnectionError,
        onRetry: (error, attempt, delayMs) =>
          logger.warn(
            `Postgres ${target} not reachable (attempt ${attempt}): ${String(error)} — retrying in ${delayMs}ms`,
          ),
      },
    );
  } catch (error) {
    await client.end({ timeout: 0 });
    throw error;
  }
}

import { Logger } from '@nestjs/common';
import { retry } from '@platform/common';
import type { AppConfig, DatabaseConfig } from '@platform/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
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
  const usage = new PoolUsage('runtime', cfg.poolMax);
  registerPoolUsage(usage);
  const db = drizzle({
    // drizzle runs every query through `unsafe()`, which postgres.js never prepares by default.
    client: preferPreparedStatements(usage.track(client)),
    schema: options.schema,
    // MUST equal drizzle.config.ts `casing` (drizzle-kit) or generated SQL and queries disagree.
    casing: 'snake_case',
    logger: cfg.logQueries ? new DrizzleQueryLogger({ logParams: !app.isProduction }) : false,
  });

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
  logger.log(`Postgres pool ready: ${target} (max ${cfg.poolMax}, prepare ${cfg.prepare})`);
  return db;
}

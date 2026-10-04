import { retry } from '@app/common';
import type { AppConfig, DatabaseConfig } from '@app/config';
import { Logger } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { DatabaseModuleOptions } from '../database.types.js';
import { runMigrations } from '../migrator/run-migrations.js';
import type { DrizzleDB, DrizzleSchema } from './drizzle.types.js';
import { DrizzleQueryLogger } from './drizzle-query.logger.js';
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
 * 1. migrations (own single-connection client + advisory lock) so the app never serves traffic
 *    against an outdated schema;
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
    await runMigrations(cfg.url, {
      logger,
      applicationName: app.serviceName,
      ...(options.migrationsFolder === undefined
        ? {}
        : { migrationsFolder: options.migrationsFolder }),
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
  const db = drizzle({
    // drizzle runs every query through `unsafe()`, which postgres.js never prepares by default.
    client: preferPreparedStatements(client),
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

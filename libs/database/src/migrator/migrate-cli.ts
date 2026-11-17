import { parseArgs } from 'node:util';
import {
  appConfig,
  databaseConfig,
  databaseMigrationEnvSchema,
  observabilityConfig,
  parseEnv,
} from '@platform/config';
import type { DatabaseMigrationSet } from '../database.types.js';
import { createMigrateCliLogger } from './cli-logger.js';
import { withPlatformMigrations } from './migration-sets.js';
import { requireMigrationUrl } from './migration-url.js';
import { runMigrations } from './run-migrations.js';

/**
 * The body of every app's `src/migrate.ts`: the one-off migration job for deploy pipelines
 * (`node dist/migrate.js` in the app's image, a k8s Job / initContainer) and `bun run db:migrate`.
 * No Nest application: config is parsed with the same zod schemas the apps use, so a bad
 * DATABASE_URL fails with the same message. Applies `platformMigrations`, then `migrations` in
 * order, under the migrations advisory lock, over DATABASE_MIGRATION_URL only (the owner role,
 * direct to the coordinator): without it the job exits 1 before connecting.
 *
 * Takes no flags: an unknown one (such as the removed `--migrations-folder`) fails instead of being
 * ignored. Sets `process.exitCode` (0 = schema current, 1 = failure) instead of exiting, so the last
 * log line is flushed. Logs are JSON lines (log shippers); `LOG_PRETTY` (default on in development)
 * switches to coloured text, and JSON is the fallback, so even a config error is reported as JSON.
 * The caller imports `reflect-metadata` first: the domain packages declare decorated classes.
 */
export async function runMigrationsCli(
  migrations: readonly DatabaseMigrationSet[],
  args: readonly string[] = process.argv.slice(2),
): Promise<void> {
  let logger = createMigrateCliLogger(false);
  try {
    parseArgs({ args: [...args], options: {}, strict: true });
    if (observabilityConfig.parse().logPretty) logger = createMigrateCliLogger(true);
    const sets = withPlatformMigrations(migrations);
    // The app's database rules, minus the system pool this job never opens (no DATABASE_SYSTEM_URL).
    const url = requireMigrationUrl(
      parseEnv(databaseConfig.namespace, databaseMigrationEnvSchema, process.env),
    );
    const { serviceName } = appConfig.parse();
    const summary = await runMigrations(url, {
      migrations: sets,
      logger,
      applicationName: serviceName,
    });
    const names = summary.sets.map((set) => set.name).join(', ');
    logger.log(`Done: ${summary.applied} applied, ${summary.total} total (${names})`);
  } catch (error) {
    // The Error itself, not `error.stack`: with `json: true` ConsoleLogger treats a lone
    // stack-formatted string as a stack trace and prints nothing (printStackTrace is a no-op in
    // JSON mode), while an Error is serialised with its message and stack.
    logger.error(error instanceof Error ? error : String(error));
    process.exitCode = 1;
  }
}

import 'reflect-metadata';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { appConfig, databaseConfig } from '@app/config';
import { Logger } from '@nestjs/common';
import { runMigrations } from './migrator/run-migrations.js';

/*
 * One-off migration entrypoint for deploy pipelines (docker compose `migrate` service, k8s Job /
 * initContainer):  node --env-file-if-exists=../../.env dist/migrate.js   (`bun run db:migrate`).
 * No Nest application: config is parsed with the same zod schemas the apps use, so a bad
 * DATABASE_URL fails with the same message. Exit code 0 = schema current, 1 = failure.
 * `reflect-metadata` first: @app/config pulls in @nestjs/config, whose decorators need it.
 *
 *   --migrations-folder <dir>   apply another drizzle-kit output folder (default: the bundled one)
 */
const logger = new Logger('DatabaseMigrate');

try {
  const { values } = parseArgs({
    options: { 'migrations-folder': { type: 'string' } },
    strict: true,
  });
  const folder = values['migrations-folder'];
  const { url } = databaseConfig.parse();
  const { serviceName } = appConfig.parse();
  const summary = await runMigrations(url, {
    logger,
    applicationName: serviceName,
    ...(folder === undefined ? {} : { migrationsFolder: resolve(folder) }),
  });
  logger.log(`Done: ${summary.applied} applied, ${summary.total} total (${summary.folder})`);
} catch (error) {
  logger.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
}

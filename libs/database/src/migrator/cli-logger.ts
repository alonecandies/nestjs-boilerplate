import { ConsoleLogger } from '@nestjs/common';

/**
 * Logger of the `migrate.ts` CLI (no Nest app, so no pino). One JSON object per line by default —
 * what log shippers ingest from deploy jobs (k8s Job, compose `migrate` service); coloured text
 * only when `pretty` (`LOG_PRETTY`, default on in development — same switch as the apps).
 */
export function createMigrateCliLogger(pretty: boolean): ConsoleLogger {
  return new ConsoleLogger(
    'DatabaseMigrate',
    pretty ? { colors: true } : { json: true, colors: false },
  );
}

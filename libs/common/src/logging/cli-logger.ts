import { ConsoleLogger } from '@nestjs/common';

/**
 * Logger of a one-off CLI (no Nest app, so no pino): the migrate, dead-letter replay and ledger
 * re-anchor jobs. One JSON object per line by default — what log shippers ingest from deploy jobs
 * (k8s Job, compose service); coloured text only when `pretty` (`LOG_PRETTY`, default on in
 * development — the same switch as the apps). The CLIs start with `pretty` false and switch once
 * the config parses, so even a config error is reported as JSON.
 */
export function createCliLogger(context: string, pretty: boolean): ConsoleLogger {
  return new ConsoleLogger(context, pretty ? { colors: true } : { json: true, colors: false });
}

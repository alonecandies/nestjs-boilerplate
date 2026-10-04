import { Logger } from '@nestjs/common';
import type { Logger as DrizzleLogger } from 'drizzle-orm/logger';

export interface DrizzleQueryLoggerOptions {
  /**
   * Log bound parameter values. They routinely contain PII / password hashes / tokens that the
   * pino redaction paths cannot see (they are positional), so this is off in production.
   */
  logParams: boolean;
}

/** Long IN-lists / bulk inserts would flood the log; past this many params only the count is kept. */
const MAX_LOGGED_PARAMS = 20;

/**
 * Routes Drizzle's query log through Nest's `Logger` (→ nestjs-pino) at `debug`, so SQL logging
 * obeys LOG_LEVEL and lands in the same structured stream as everything else.
 */
export class DrizzleQueryLogger implements DrizzleLogger {
  private readonly logger = new Logger('Drizzle');

  constructor(private readonly options: DrizzleQueryLoggerOptions) {}

  logQuery(query: string, params: unknown[]): void {
    const logParams = this.options.logParams && params.length <= MAX_LOGGED_PARAMS;
    this.logger.debug({ query, ...(logParams ? { params } : { paramCount: params.length }) });
  }
}

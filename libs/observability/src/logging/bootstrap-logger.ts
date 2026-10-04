import type { ObservabilityConfig, LogLevel as PinoLogLevel } from '@app/config';
import { ConsoleLogger, type LoggerService, type LogLevel } from '@nestjs/common';

/** Nest log levels enabled by each `LOG_LEVEL` (pino `info` = Nest `log`, `trace` = `verbose`). */
const NEST_LOG_LEVELS: Readonly<Record<PinoLogLevel, readonly LogLevel[]>> = {
  trace: ['verbose', 'debug', 'log', 'warn', 'error', 'fatal'],
  debug: ['debug', 'log', 'warn', 'error', 'fatal'],
  info: ['log', 'warn', 'error', 'fatal'],
  warn: ['warn', 'error', 'fatal'],
  error: ['error', 'fatal'],
  fatal: ['fatal'],
  silent: [],
};

type JsonLogOptions = Parameters<ConsoleLogger['getJsonLogObject']>[1];
type JsonLogObject = ReturnType<ConsoleLogger['getJsonLogObject']>;

/** Nest's JSON console logger plus the `service` field every pino line carries. */
class ServiceJsonLogger extends ConsoleLogger {
  constructor(
    private readonly service: string,
    logLevels: LogLevel[],
  ) {
    super({ json: true, colors: false, logLevels });
  }

  protected override getJsonLogObject(message: unknown, options: JsonLogOptions): JsonLogObject {
    return { ...super.getJsonLogObject(message, options), service: this.service };
  }
}

/**
 * Logger for the Nest CREATE phase, before `app.useLogger(pino)` can run: a provider factory that
 * can't reach Redis/Postgres/Cassandra fails inside `NestFactory.create`, and Nest prints that error
 * (and the buffered bootstrap logs) through whatever logger is installed at that point. Nest's
 * default is coloured multi-line text that log pipelines can't parse; this returns a single-line
 * JSON `ConsoleLogger` (with `service`, filtered by `LOG_LEVEL`) whenever the app logs JSON.
 *
 * `undefined` when `LOG_PRETTY` is on: Nest's default human-readable console logger is kept.
 */
export function createBootstrapLogger(config: ObservabilityConfig): LoggerService | undefined {
  if (config.logPretty) return undefined;
  return new ServiceJsonLogger(config.serviceName, [...NEST_LOG_LEVELS[config.logLevel]]);
}

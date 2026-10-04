import { appConfig, type EnvSource, observabilityConfig } from '@app/config';
import type { LoggerService } from '@nestjs/common';
import { Logger, PinoLogger } from 'nestjs-pino';
import { buildLoggerParams } from './logger-params.js';

type LogMethod = 'log' | 'error' | 'warn' | 'debug' | 'verbose' | 'fatal';

/**
 * Nest `LoggerService` whose lines carry a fixed `context` unless the caller passes one (Nest's
 * convention: the LAST optional param is the context).
 */
class ContextBoundLogger implements LoggerService {
  constructor(
    private readonly logger: Logger,
    private readonly context: string,
  ) {}

  log(message: unknown, ...params: unknown[]): void {
    this.write('log', message, params);
  }

  error(message: unknown, ...params: unknown[]): void {
    this.write('error', message, params);
  }

  warn(message: unknown, ...params: unknown[]): void {
    this.write('warn', message, params);
  }

  debug(message: unknown, ...params: unknown[]): void {
    this.write('debug', message, params);
  }

  verbose(message: unknown, ...params: unknown[]): void {
    this.write('verbose', message, params);
  }

  fatal(message: unknown, ...params: unknown[]): void {
    this.write('fatal', message, params);
  }

  private write(method: LogMethod, message: unknown, params: readonly unknown[]): void {
    if (params.length === 0) this.logger[method](message, this.context);
    else this.logger[method](message, ...params);
  }
}

/**
 * A pino-backed `LoggerService` for code that runs WITHOUT a Nest application: the cluster primary,
 * migration scripts, CLI tools. Same JSON shape as the app logs (string `level`, `service`,
 * redaction, trace ids), written synchronously so nothing is lost when such a process exits.
 *
 * nestjs-pino keeps ONE root logger per process (first params win), so create it only in processes
 * that do not also boot Nest — inside an app, inject `PinoLogger` / use `new Logger(Ctx.name)`.
 */
export function createStandaloneLogger(context: string, env?: EnvSource): LoggerService {
  const params = buildLoggerParams(observabilityConfig.parse(env), appConfig.parse(env), {
    sync: true,
  });
  return new ContextBoundLogger(new Logger(new PinoLogger(params), params), context);
}

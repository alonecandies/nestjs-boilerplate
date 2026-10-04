import { flushLogs } from '@app/observability';
import { Logger, type LoggerService } from '@nestjs/common';

export interface ProcessHandlersOptions {
  /**
   * Arm a hard-exit timer on SIGTERM/SIGINT: if graceful shutdown (drain, `onApplicationShutdown`
   * hooks, connection close) takes longer, the process exits with code 1 instead of hanging until
   * the orchestrator SIGKILLs it without a trace. Typically `appConfig.shutdownTimeoutMs`.
   */
  shutdownTimeoutMs?: number;
  /**
   * Exit on unhandled promise rejections (Node's own default since v15). A handler that only logs
   * would keep a process running in an unknown state. Default `true`.
   */
  exitOnUnhandledRejection?: boolean;
}

/** Time given to the log destination to drain before a fatal exit. */
const FATAL_FLUSH_TIMEOUT_MS = 1_000;
const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

/**
 * Nest's static `Logger` delegates to the application logger once `app.useLogger()` ran, so the
 * default already writes pino JSON inside an app.
 */
const defaultLogger = (): LoggerService => new Logger('Process');

/** `LoggerService.fatal` is optional in Nest's contract. */
function logFatal(logger: LoggerService, error: Error, context: string): void {
  if (logger.fatal === undefined) logger.error(error, context);
  else logger.fatal(error, context);
}

function exitAfterFlush(code: number): void {
  void flushLogs(FATAL_FLUSH_TIMEOUT_MS).finally(() => process.exit(code));
}

/**
 * Starts the forced-exit countdown of a graceful shutdown. The timer is `unref()`ed, so a shutdown
 * that finishes in time exits normally and never waits for it.
 */
export function armShutdownTimer(
  timeoutMs: number,
  logger: LoggerService = defaultLogger(),
): NodeJS.Timeout {
  const timer = setTimeout(() => {
    logger.error(`Graceful shutdown exceeded ${timeoutMs} ms; forcing exit`);
    exitAfterFlush(1);
  }, timeoutMs);
  timer.unref();
  return timer;
}

interface InstalledHandlers {
  uninstall: () => void;
}

let installed: InstalledHandlers | undefined;

/**
 * Process-level safety nets, installed once per process (later calls return the first
 * installation's `uninstall`):
 * - `uncaughtException` → log `fatal` with the stack, flush logs, exit 1 (state is undefined
 *   after an uncaught throw; restarting is the only safe recovery).
 * - `unhandledRejection` → same (unless `exitOnUnhandledRejection: false`, then log `error`).
 * - `warning` → log `warn` (MaxListenersExceeded, deprecations: otherwise raw stderr text).
 * - SIGTERM/SIGINT → `armShutdownTimer(shutdownTimeoutMs)` when a timeout is given. The listener
 *   only arms the timer; `app.enableShutdownHooks()` owns the actual shutdown.
 *
 * Returns a function removing the handlers (tests).
 */
export function installProcessHandlers(
  logger: LoggerService = defaultLogger(),
  options: ProcessHandlersOptions = {},
): () => void {
  if (installed !== undefined) return installed.uninstall;
  const exitOnUnhandledRejection = options.exitOnUnhandledRejection ?? true;

  const onUncaughtException = (error: Error, origin: string): void => {
    logFatal(logger, error, `Process (${origin})`);
    exitAfterFlush(1);
  };
  const onUnhandledRejection = (reason: unknown): void => {
    const error =
      reason instanceof Error ? reason : new Error(`Unhandled rejection: ${String(reason)}`);
    if (!exitOnUnhandledRejection) {
      logger.error(error, 'Process (unhandledRejection)');
      return;
    }
    logFatal(logger, error, 'Process (unhandledRejection)');
    exitAfterFlush(1);
  };
  const onWarning = (warning: Error): void => {
    logger.warn(`${warning.name}: ${warning.message}`, 'Process');
  };
  const { shutdownTimeoutMs } = options;
  const onShutdownSignal = (signal: NodeJS.Signals): void => {
    if (shutdownTimeoutMs === undefined) return;
    logger.log(`${signal} received; forcing exit in ${shutdownTimeoutMs} ms if still running`);
    armShutdownTimer(shutdownTimeoutMs, logger);
  };

  process.on('uncaughtException', onUncaughtException);
  process.on('unhandledRejection', onUnhandledRejection);
  process.on('warning', onWarning);
  if (shutdownTimeoutMs !== undefined) {
    for (const signal of SHUTDOWN_SIGNALS) process.once(signal, onShutdownSignal);
  }

  const uninstall = (): void => {
    process.off('uncaughtException', onUncaughtException);
    process.off('unhandledRejection', onUnhandledRejection);
    process.off('warning', onWarning);
    for (const signal of SHUTDOWN_SIGNALS) process.off(signal, onShutdownSignal);
    installed = undefined;
  };
  installed = { uninstall };
  return uninstall;
}

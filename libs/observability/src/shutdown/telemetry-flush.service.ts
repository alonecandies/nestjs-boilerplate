import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type pino from 'pino';
import { shutdownTracing } from '../otel.js';

/** Upper bound for draining the log buffer; a wedged stdout must not block shutdown. */
const LOG_FLUSH_TIMEOUT_MS = 2_000;

/** Flushes pino's root logger (async destination buffer / transport), bounded by a timeout. */
export function flushLogs(timeoutMs: number = LOG_FLUSH_TIMEOUT_MS): Promise<void> {
  // `root` is only set once nestjs-pino created its logger (undefined in bare test contexts).
  const root = PinoLogger.root as pino.Logger | undefined;
  if (root === undefined) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref();
    root.flush(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Last step of graceful shutdown (requires `app.enableShutdownHooks()`): exports pending spans and
 * drains the async log buffer. Without it the final spans and log lines are lost (research
 * integrations GOTCHA 5). ObservabilityModule is global and Nest runs global modules' shutdown
 * hooks last, so other modules' shutdown logs are flushed too.
 */
@Injectable()
export class TelemetryFlushService implements OnApplicationShutdown {
  private readonly logger = new Logger(TelemetryFlushService.name);

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.logger.log(`Shutdown complete${signal === undefined ? '' : ` (${signal})`}`);
    await shutdownTracing();
    await flushLogs();
  }
}

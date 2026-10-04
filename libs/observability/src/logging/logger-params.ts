import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { hostname } from 'node:os';
import { requestPath } from '@app/common';
import type { AppConfig, ObservabilityConfig } from '@app/config';
import { isSpanContextValid, trace } from '@opentelemetry/api';
import { memoize } from 'lodash-es';
import type { Params } from 'nestjs-pino';
import pino from 'pino';
import type { Options as PinoHttpOptions } from 'pino-http';
import { QUIET_LOG_PATH_PREFIXES } from '../observability.constants.js';
import { requestIdOf, resolveRpcRequestId } from './request-id.js';
import { rpcErrorObject, rpcLogLevel } from './rpc-error-logging.js';

/**
 * Log paths masked with `[REDACTED]`. Headers are listed although our serializers drop them, so a
 * future serializer change can't leak credentials; `*.x` covers one level of nesting
 * (`{ body: { password } }`). Keep the list short: every wildcard costs on every log line.
 */
export const LOG_REDACT_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["stripe-signature"]',
  'res.headers["set-cookie"]',
  'password',
  'token',
  'accessToken',
  'refreshToken',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.secret',
  '*.apiKey',
];

/** Shape pino-std-serializers hands to our `req` serializer (pino-http `wrapSerializers`). */
interface SerializedRequestLike {
  id?: unknown;
  method?: string;
  url?: string;
  remoteAddress?: string;
}

/**
 * pino mixin adding the active span's ids to EVERY log line (Loki derives trace links from
 * `trace_id`). `@opentelemetry/instrumentation-pino` does the same when tracing runs; the mixins
 * are merged with `Object.assign`, so there are no duplicate keys — this one is the fallback when
 * pino wasn't patched. Must return a fresh object: pino merges log fields INTO the mixin result.
 */
export function traceContextMixin(): Record<string, string> {
  const span = trace.getActiveSpan();
  if (span === undefined) return {};
  const spanContext = span.spanContext();
  if (!isSpanContextValid(spanContext)) return {};
  return {
    trace_id: spanContext.traceId,
    span_id: spanContext.spanId,
    trace_flags: `0${spanContext.traceFlags.toString(16)}`,
  };
}

const isQuietPath = (req: IncomingMessage): boolean => {
  const path = requestPath(req);
  return QUIET_LOG_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
};

function logLevelFor(
  _req: IncomingMessage,
  res: ServerResponse,
  error?: Error,
): pino.LevelWithSilent {
  if (error !== undefined || res.statusCode >= 500) return 'error';
  if (res.statusCode >= 400) return 'warn';
  return 'info';
}

/**
 * Absolute path of `pino-pretty` when it is installed (a devDependency: absent from production
 * images). Resolved from THIS package — pino itself can't see it under Bun's isolated linker.
 */
export const resolvePrettyTransportTarget = memoize((): string | undefined => {
  try {
    return createRequire(import.meta.url).resolve('pino-pretty');
  } catch {
    return undefined;
  }
});

export interface LoggerParamsOptions {
  /**
   * Write synchronously instead of through the buffered async destination. For processes that
   * never boot Nest (cluster primary, scripts): they have no `TelemetryFlushService` to flush the
   * buffer, and they log too rarely for buffering to matter.
   */
  sync?: boolean;
}

/**
 * nestjs-pino parameters: JSON to stdout with a string `level`, `service`, `requestId` (the same id
 * as Fastify `request.id` and `cls.getId()`), `trace_id`/`span_id`, redaction, no request/response
 * lines for probes/scrapes, and a per-message context for gRPC/Kafka handlers.
 *
 * Production writes through an async `pino.destination` (4 KiB buffer, flushed at least every
 * second and on shutdown by `TelemetryFlushService`); `LOG_PRETTY` switches to the pino-pretty
 * worker-thread transport when that package is resolvable.
 */
export function buildLoggerParams(
  observability: ObservabilityConfig,
  app: AppConfig,
  options: LoggerParamsOptions = {},
): Params {
  const prettyTarget = observability.logPretty ? resolvePrettyTransportTarget() : undefined;
  const sync = options.sync ?? false;

  const pinoHttp: PinoHttpOptions = {
    level: observability.logLevel,
    base: { service: app.serviceName, pid: process.pid, hostname: hostname() },
    mixin: traceContextMixin,
    redact: { paths: [...LOG_REDACT_PATHS], censor: '[REDACTED]' },
    // Slim request/response objects: no headers (PII, cost), no query string (may carry tokens).
    serializers: {
      req: (req: SerializedRequestLike) => ({
        id: req.id,
        method: req.method,
        url: requestPath({ url: req.url }),
        remoteAddress: req.remoteAddress,
      }),
      res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
    },
    genReqId: (req) => requestIdOf(req),
    customAttributeKeys: { reqId: 'requestId' },
    // Loggers inside a request bind only `requestId` (not the whole req) → cheaper lines.
    quietReqLogger: true,
    autoLogging: { ignore: isQuietPath },
    customLogLevel: logLevelFor,
    ...(prettyTarget === undefined
      ? {
          // Level as a label ("info") — the Loki pipeline lifts it into a stream label.
          formatters: { level: (label: string) => ({ level: label }) },
          stream: sync
            ? pino.destination({ dest: 1, sync: true })
            : pino.destination({ dest: 1, minLength: 4096, sync: false, periodicFlush: 1_000 }),
        }
      : {
          transport: {
            target: prettyTarget,
            options: {
              singleLine: true,
              colorize: true,
              translateTime: 'SYS:HH:MM:ss.l',
              ignore: 'pid,hostname,service',
            },
          },
        }),
  };

  return {
    pinoHttp,
    // Nest 12 microservice pre-request hooks: every @MessagePattern/@EventPattern handler gets its
    // own logging context (hybrid apps must connect with `inheritAppConfig: true`). Like HTTP,
    // caller errors (NOT_FOUND, conflicts, auth, validation) are `warn` without a stack; only
    // server-side failures are `error`.
    microservice: {
      genReqId: resolveRpcRequestId,
      customAttributeKeys: { reqId: 'requestId' },
      quietRpcLogger: true,
      includePayload: false,
      customLogLevel: rpcLogLevel,
      customErrorObject: rpcErrorObject,
    },
  };
}

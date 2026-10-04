import { constants as zlib } from 'node:zlib';
import { HTTP_HEADERS } from '@app/common';
import { type AppConfig, appConfig } from '@app/config';
import { observeInstrument, resolveRequestId } from '@app/observability';
import fastifyCompress, { type FastifyCompressOptions } from '@fastify/compress';
import fastifyCookie from '@fastify/cookie';
import fastifyHelmet, { type FastifyHelmetOptions } from '@fastify/helmet';
import type { FastifyMultipartOptions } from '@fastify/multipart';
import type { NestApplicationOptions, Type } from '@nestjs/common';
import { VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyServerOptions, RawServerDefault } from 'fastify';
import { Logger } from 'nestjs-pino';
import { installProcessHandlers } from '../process/process-handlers.js';
import { defaultHelmetOptions } from './security.js';

/** Multipart limits for `multipart: { ... }` (per-route interceptor limits still apply on top). */
export type MultipartLimits = NonNullable<FastifyMultipartOptions['limits']>;

/** The HTTP wiring `configureHttpApp` applies on top of a created Fastify Nest application. */
export interface HttpAppSetupOptions {
  /** CORS for `CORS_ORIGINS` with credentials. Default true. */
  cors?: boolean;
  /** `@fastify/cookie` (`req.cookies`, `reply.setCookie`). Default true. */
  cookies?: boolean;
  /** br/gzip/deflate for responses ≥ 1 KiB. Default true. */
  compression?: boolean;
  /** Global helmet options, or `false` to disable. Default `defaultHelmetOptions(appConfig)`. */
  helmet?: FastifyHelmetOptions | false;
  /** `installProcessHandlers()` (fatal logging + forced-exit timer). Default: not in NODE_ENV=test. */
  processHandlers?: boolean;
  /**
   * `enableShutdownHooks(['SIGTERM','SIGINT'], { useProcessExit: true })`. Default true; tests that
   * build many apps in one process pass `false` (`app.close()` still runs every shutdown hook).
   */
  shutdownHooks?: boolean;
  /** Pre-parsed `app` config (tests); default `appConfig.parse()` from the environment. */
  config?: AppConfig;
}

export interface CreateHttpAppOptions extends HttpAppSetupOptions {
  /** Keep the raw request body (`req.rawBody`) — needed for Stripe webhook signatures. Default false. */
  rawBody?: boolean;
  /**
   * `true`/limits: register `@fastify/multipart` at init with bounded limits (defaults below).
   * `false`: never. Unset: the adapter registers it lazily when an upload interceptor is used.
   */
  multipart?: boolean | MultipartLimits;
  /** Extra Nest application options (merged last). */
  appOptions?: NestApplicationOptions;
}

/**
 * `new FastifyAdapter(options)` input for a plain HTTP/1.1 server. Spelled out (instead of the
 * adapter's constructor parameter) so the adapter infers `FastifyAdapter<RawServerDefault>` — the
 * type `NestFastifyApplication` and `@app/testing`'s `createFastifyTestApp({ adapter })` expect;
 * the constructor-parameter type widens the server to `RawServerBase` (HTTP/2 included).
 */
export type FastifyAdapterOptions = FastifyServerOptions<RawServerDefault> & {
  multipart?: boolean | FastifyMultipartOptions;
};

/** Bounded multipart defaults: a single request can't hold unlimited files/fields in memory. */
export const DEFAULT_MULTIPART_LIMITS: MultipartLimits = {
  fileSize: 25 * 1024 * 1024,
  files: 10,
  fields: 50,
  fieldSize: 1024 * 1024,
  parts: 100,
  headerPairs: 200,
};

const COMPRESSION_OPTIONS: FastifyCompressOptions = {
  global: true,
  threshold: 1024,
  encodings: ['br', 'gzip', 'deflate'],
  // Brotli's default quality (11) costs ~10x the CPU of 4 for a few % smaller dynamic responses.
  brotliOptions: { params: { [zlib.BROTLI_PARAM_QUALITY]: 4 } },
};

const EXPOSED_HEADERS = [
  HTTP_HEADERS.REQUEST_ID,
  HTTP_HEADERS.CORRELATION_ID,
  HTTP_HEADERS.RETRY_AFTER,
];

/** Preflight cache: browsers re-send OPTIONS at most once a day per URL. */
const CORS_MAX_AGE_SEC = 86_400;

function multipartOption(multipart: CreateHttpAppOptions['multipart']): {
  multipart?: boolean | FastifyMultipartOptions;
} {
  if (multipart === undefined) return {};
  if (multipart === false) return { multipart: false };
  const limits =
    multipart === true ? DEFAULT_MULTIPART_LIMITS : { ...DEFAULT_MULTIPART_LIMITS, ...multipart };
  return { multipart: { limits } };
}

/**
 * Fastify server options derived from the `app` config.
 * - `requestIdHeader: false` + `genReqId: resolveRequestId`: Fastify's `requestIdHeader` would adopt
 *   ANY incoming header value unvalidated; `resolveRequestId` only accepts a safe one, else mints a
 *   UUIDv7 — and it is the same function pino-http and nestjs-cls use, so all three ids agree.
 * - `keepAliveTimeout` > the load balancer's idle timeout (60 s) avoids sporadic 502s.
 * - `requestTimeout` bounds the time to RECEIVE a request (slowloris); `connectionTimeout: 0`
 *   because a socket-inactivity timeout would cut socket.io long-polling and slow streams.
 * - `forceCloseConnections: 'idle'`: on close, idle keep-alive sockets are dropped at once while
 *   in-flight requests finish (Nest's `forceCloseConnections` would destroy those too).
 */
export function buildFastifyOptions(
  config: AppConfig,
  options: Pick<CreateHttpAppOptions, 'multipart'> = {},
): FastifyAdapterOptions {
  return {
    // pino-http (nestjs-pino) logs requests; Fastify's own logger (and request logging) stays off.
    logger: false,
    trustProxy: config.trustProxy,
    bodyLimit: config.bodyLimitBytes,
    keepAliveTimeout: config.keepAliveTimeoutMs,
    requestTimeout: config.requestTimeoutMs,
    connectionTimeout: 0,
    requestIdHeader: false,
    genReqId: (request) => resolveRequestId(request),
    return503OnClosing: true,
    forceCloseConnections: 'idle',
    routerOptions: { ignoreTrailingSlash: true, maxParamLength: 500 },
    ...multipartOption(options.multipart),
  };
}

function appLogger(app: NestFastifyApplication): Logger {
  try {
    return app.get(Logger);
  } catch (error) {
    throw new Error(
      'createHttpApp/configureHttpApp: nestjs-pino Logger not found — import ObservabilityModule.forRoot() (and ' +
        'AppConfigModule.forRoot()) in the root module',
      { cause: error },
    );
  }
}

/**
 * Creates the Fastify-based Nest application every HTTP-facing app uses: `buildFastifyOptions`
 * (request ids shared by Fastify/pino/cls, timeouts, body limit), buffered bootstrap logs, optional
 * `@nestjs/observe` instrumentation, then `configureHttpApp` (logger, helmet, compression, cookies,
 * CORS, URI versioning, graceful shutdown).
 *
 * The root module must import `AppConfigModule.forRoot()` and `ObservabilityModule.forRoot()`.
 * Call `setupApiDocs()` / `listen()` afterwards.
 */
export async function createHttpApp(
  module: Type<unknown>,
  options: CreateHttpAppOptions = {},
): Promise<NestFastifyApplication> {
  const config = options.config ?? appConfig.parse();
  const adapter = new FastifyAdapter(buildFastifyOptions(config, options));
  const instrument = observeInstrument();

  const app = await NestFactory.create<NestFastifyApplication>(module, adapter, {
    bufferLogs: true,
    // Rethrow boot errors (DI, config) to the caller instead of `process.abort()`.
    abortOnError: false,
    rawBody: options.rawBody ?? false,
    ...(instrument === undefined ? {} : { instrument }),
    ...options.appOptions,
  });

  await configureHttpApp(app, { ...options, config });
  return app;
}

/**
 * The production HTTP wiring, applied to an already-created application: pino logger (flushes the
 * buffered bootstrap logs), process safety nets, helmet, compression, cookies, CORS, URI versioning
 * (default `v1`; ops routes are VERSION_NEUTRAL) and graceful shutdown (`SIGTERM`/`SIGINT` → Nest
 * hooks → `process.exit` so pino's exit flush runs).
 *
 * Exported so e2e tests can boot the REAL root module from a `TestingModule` (providers overridden
 * with fakes) and still exercise exactly what `createHttpApp` ships — pair it with an adapter from
 * `new FastifyAdapter(buildFastifyOptions(config))`. Call it before `app.init()`.
 */
export async function configureHttpApp(
  app: NestFastifyApplication,
  options: HttpAppSetupOptions = {},
): Promise<void> {
  const config = options.config ?? appConfig.parse();

  app.useLogger(appLogger(app));
  if (options.processHandlers ?? !config.isTest) {
    installProcessHandlers(undefined, { shutdownTimeoutMs: config.shutdownTimeoutMs });
  }

  const helmet = options.helmet ?? defaultHelmetOptions(config);
  if (helmet !== false) await app.register(fastifyHelmet, { ...helmet, global: true });
  if (options.compression ?? true) await app.register(fastifyCompress, COMPRESSION_OPTIONS);
  if (options.cookies ?? true) await app.register(fastifyCookie);
  if (options.cors ?? true) {
    app.enableCors({
      origin: config.corsOrigins,
      credentials: true,
      exposedHeaders: EXPOSED_HEADERS,
      maxAge: CORS_MAX_AGE_SEC,
    });
  }

  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  if (options.shutdownHooks ?? true) {
    app.enableShutdownHooks(['SIGTERM', 'SIGINT'], { useProcessExit: true });
  }
}

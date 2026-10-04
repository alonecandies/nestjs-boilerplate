/**
 * OpenTelemetry bootstrap (subpath `@app/observability/otel`). Each app's `src/instrument.ts` runs
 *   `await startTracing({ serviceName: '<app>' })`
 * and is preloaded with `node --import ./dist/instrument.js dist/main.js`, so the ESM loader hook and
 * the instrumentations are in place BEFORE any instrumented module (http, grpc, kafkajs, ioredis…)
 * is imported.
 *
 * Rules for this file (research integrations §9):
 * - MUST NOT import Nest, `@app/config` or anything instrumented: whatever it imports is loaded
 *   before the hook exists and would never be patched. It is also the one documented place outside
 *   `libs/config` that reads `process.env` (the standard `OTEL_*` variables).
 * - The SDK is imported lazily, so a process with tracing off pays nothing for
 *   `@opentelemetry/auto-instrumentations-node` (~40 packages). This also keeps the file cheap for
 *   the Nest side, which imports `shutdownTracing()` from here to flush spans on shutdown (same file
 *   URL → same module instance as the `--import`ed one).
 * - Traces only: prom-client owns metrics (`/metrics`) and pino owns logs (stdout), so sdk-node's
 *   implicit OTLP metrics/logs pipelines are disabled explicitly (`metricReaders: []`,
 *   `logRecordProcessors: []`).
 * - Exporter, protocol, endpoint and sampler come from the standard env (`OTEL_TRACES_EXPORTER`,
 *   `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_PROTOCOL`, `OTEL_TRACES_SAMPLER[_ARG]`).
 */
import type { IncomingMessage } from 'node:http';
import { register } from 'node:module';
import type { NodeSDK } from '@opentelemetry/sdk-node';

/** Environment shape read by this module (defaults to `process.env`). */
export type TracingEnv = Readonly<Record<string, string | undefined>>;

export interface StartTracingOptions {
  /**
   * Fallback `service.name`. Precedence: `OTEL_SERVICE_NAME` > `SERVICE_NAME` > this value, so ops
   * can rename a deployment without a rebuild.
   */
  serviceName?: string;
  /** Environment to read (tests); defaults to `process.env`. */
  env?: TracingEnv;
}

/** Incoming requests that never get a server span: probes and scrapes would dominate every trace view. */
const UNTRACED_PATH_PREFIXES = ['/health', '/metrics', '/favicon.ico'] as const;

const TRUTHY = new Set(['true', '1']);
const FALSY = new Set(['false', '0']);

let sdk: NodeSDK | undefined;
let starting: Promise<void> | undefined;

/** Parses an env flag the same way `@app/config`'s `zBool` does (blank = unset). */
function envFlag(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized === '') return undefined;
  if (TRUTHY.has(normalized)) return true;
  if (FALSY.has(normalized)) return false;
  return undefined;
}

const nonBlank = (value: string | undefined): string | undefined =>
  value === undefined || value.trim() === '' ? undefined : value.trim();

/**
 * Mirrors `observabilityConfig.tracingEnabled`: an explicit `OTEL_SDK_DISABLED` wins; otherwise
 * tracing is on only when an OTLP endpoint is configured (so a laptop without a collector never
 * spams connection errors). `@app/config` can't be imported here (it pulls in Nest).
 */
export function isTracingEnabled(env: TracingEnv = process.env): boolean {
  const disabled = envFlag(env['OTEL_SDK_DISABLED']);
  if (disabled !== undefined) return !disabled;
  return (
    nonBlank(env['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT']) !== undefined ||
    nonBlank(env['OTEL_EXPORTER_OTLP_ENDPOINT']) !== undefined
  );
}

/** Whether `startTracing()` has installed a running SDK in this process. */
export function isTracingActive(): boolean {
  return sdk !== undefined;
}

function isUntracedRequest(request: IncomingMessage): boolean {
  const url = request.url ?? '';
  return UNTRACED_PATH_PREFIXES.some((prefix) => url.startsWith(prefix));
}

/**
 * Installs the import-in-the-middle ESM hook and starts the NodeSDK (traces only). Idempotent and
 * a no-op when tracing is disabled (see `isTracingEnabled`). Never registers signal handlers:
 * `app.enableShutdownHooks()` owns signals and `TelemetryFlushService` calls `shutdownTracing()`.
 */
export function startTracing(options: StartTracingOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  if (sdk !== undefined || !isTracingEnabled(env)) return Promise.resolve();
  starting ??= doStartTracing(env, options.serviceName).finally(() => {
    starting = undefined;
  });
  return starting;
}

async function doStartTracing(env: TracingEnv, fallbackServiceName?: string): Promise<void> {
  // Load the SDK first, then register the hook, then construct the instrumentations: the order the
  // research verified on Node 24 (instrumentations announce their Hook()s through the channel).
  const [{ createAddHookMessageChannel }, sdkNode, autoInstrumentations, resources] =
    await Promise.all([
      import('import-in-the-middle'),
      import('@opentelemetry/sdk-node'),
      import('@opentelemetry/auto-instrumentations-node'),
      import('@opentelemetry/resources'),
    ]);

  // Only modules some instrumentation Hook()s are wrapped → minimal loader overhead.
  const { registerOptions, waitForAllMessagesAcknowledged } = createAddHookMessageChannel();
  // `module.register` is only doc-deprecated (no runtime warning on Node 24). Its replacement,
  // iitm's in-thread `register-hooks.mjs` (`module.registerHooks`), has no message channel and
  // would wrap EVERY module unless given a static `include` list the instrumentations don't expose.
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- verified path, see above
  register('import-in-the-middle/hook.mjs', import.meta.url, registerOptions);

  const serviceName =
    nonBlank(env['OTEL_SERVICE_NAME']) ?? nonBlank(env['SERVICE_NAME']) ?? fallbackServiceName;
  const deploymentEnvironment = nonBlank(env['NODE_ENV']);

  const instance = new sdkNode.NodeSDK({
    ...(serviceName === undefined ? {} : { serviceName }),
    // Detected attributes (OTEL_RESOURCE_ATTRIBUTES, host, process…) are merged OVER this base.
    resource: resources
      .defaultResource()
      .merge(
        resources.resourceFromAttributes(
          deploymentEnvironment === undefined
            ? {}
            : { 'deployment.environment.name': deploymentEnvironment },
        ),
      ),
    metricReaders: [],
    logRecordProcessors: [],
    // Explicit list: the default `all` includes cloud metadata detectors that probe AWS/GCP/Azure
    // endpoints at startup.
    resourceDetectors: [
      resources.envDetector,
      resources.hostDetector,
      resources.osDetector,
      resources.processDetector,
      resources.serviceInstanceIdDetector,
    ],
    instrumentations: [
      autoInstrumentations.getNodeAutoInstrumentations({
        // Noise / cost without insight at our scale.
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
        '@opentelemetry/instrumentation-net': { enabled: false },
        // Metrics-only instrumentation; prom-client owns metrics.
        '@opentelemetry/instrumentation-runtime-node': { enabled: false },
        '@opentelemetry/instrumentation-http': { ignoreIncomingRequestHook: isUntracedRequest },
        // Keep trace_id/span_id injection into pino lines; logs are shipped from stdout, not OTLP.
        '@opentelemetry/instrumentation-pino': { disableLogSending: true },
        // Background commands (health pings, BullMQ polling) would otherwise create root spans.
        '@opentelemetry/instrumentation-ioredis': { requireParentSpan: true },
      }),
    ],
  });
  instance.start();
  sdk = instance;

  // Every Hook() must be known to the loader thread before application code is imported.
  await waitForAllMessagesAcknowledged();
}

/**
 * Flushes pending spans and stops the SDK. Safe to call when tracing never started or twice.
 * Errors are swallowed: shutdown must not fail because the collector is unreachable.
 */
export async function shutdownTracing(): Promise<void> {
  await starting?.catch(() => undefined);
  const instance = sdk;
  sdk = undefined;
  await instance?.shutdown().catch(() => undefined);
}

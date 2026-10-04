/**
 * @app/observability — logs (pino), request context (nestjs-cls), Prometheus metrics, terminus
 * health, OpenTelemetry tracing helpers and `@nestjs/observe`, wired by `ObservabilityModule`.
 *
 * The OpenTelemetry SDK bootstrap is NOT exported here: it lives in the `@app/observability/otel`
 * subpath, which must be preloaded (`node --import ./dist/instrument.js`) before Nest is imported.
 */

// prom-client helpers for app-specific metrics (`@InjectMetric(name)` in the consumer).
export {
  InjectMetric,
  makeCounterProvider,
  makeGaugeProvider,
  makeHistogramProvider,
  makeSummaryProvider,
} from '@willsoto/nestjs-prometheus';
export { RequestContextInterceptor } from './context/request-context.interceptor.js';
export {
  RequestContextService,
  type RunInRequestContextOptions,
} from './context/request-context.service.js';
export { HealthController } from './health/health.controller.js';
export type { ResolvedHealthOptions } from './health/health.types.js';
export { HealthContributor } from './health/health-contributor.js';
export { HealthContributorRegistry } from './health/health-contributor.registry.js';
export {
  buildLoggerParams,
  LOG_REDACT_PATHS,
  type LoggerParamsOptions,
  traceContextMixin,
} from './logging/logger-params.js';
export {
  incomingCorrelationId,
  type RequestIdCarrier,
  requestIdOf,
  resolveContextRequestId,
  resolveRequestId,
  resolveRpcRequestId,
} from './logging/request-id.js';
export { createStandaloneLogger } from './logging/standalone-logger.js';
export {
  enableClusterMetricsAggregation,
  enableClusterMetricsWorker,
  requestClusterMetrics,
} from './metrics/cluster-metrics.js';
export {
  type HttpMetricLabels,
  HttpMetricsHook,
  type HttpMetricsTarget,
  httpMetricLabels,
} from './metrics/http-metrics.hook.js';
export {
  HTTP_DURATION_BUCKETS,
  HTTP_METRIC_LABEL_NAMES,
  HTTP_REQUEST_DURATION_SECONDS,
  METRICS_PATH,
  UNMATCHED_ROUTE,
} from './metrics/metrics.constants.js';
export { MetricsController } from './metrics/metrics.controller.js';
export {
  CLS_CORRELATION_ID,
  CLS_USER_ID,
  DEFAULT_READINESS_TIMEOUT_MS,
  HEALTH_OPTIONS,
} from './observability.constants.js';
export { ObservabilityModule, type ObservabilityModuleOptions } from './observability.module.js';
export {
  buildObserveOptions,
  isObserveEnabled,
  ObserveInstrument,
  type ObserveInstrumentation,
  ObserveModule,
  observeInstrument,
  observeTraceIdGenerator,
} from './observe/observe.js';
export { isTracingActive, isTracingEnabled, shutdownTracing } from './otel.js';
export { flushLogs, TelemetryFlushService } from './shutdown/telemetry-flush.service.js';
export { CurrentSpan, Span, Traceable, TraceService } from './tracing/tracing.module.js';

import { Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { type ObservabilityConfig, observabilityConfig } from '@platform/config';
import { makeHistogramProvider } from '@willsoto/nestjs-prometheus';
import { collectDefaultMetrics, register } from 'prom-client';
import { enableClusterMetricsWorker } from './cluster-metrics.js';
import { HttpMetricsHook } from './http-metrics.hook.js';
import {
  DEFAULT_METRICS_SENTINEL,
  HTTP_DURATION_BUCKETS,
  HTTP_METRIC_LABEL_NAMES,
  HTTP_REQUEST_DURATION_SECONDS,
} from './metrics.constants.js';
import { MetricsListener } from './metrics-listener.js';

/** Registers this worker with the primary's aggregator at boot (no-op outside cluster workers). */
@Injectable()
class ClusterMetricsWorkerBridge implements OnModuleInit {
  onModuleInit(): void {
    enableClusterMetricsWorker();
  }
}

/** Node default metrics (`process_*`, `nodejs_*`, names used by the Grafana dashboard). */
@Injectable()
class DefaultMetricsCollector implements OnModuleInit {
  constructor(@Inject(observabilityConfig.KEY) private readonly config: ObservabilityConfig) {}

  onModuleInit(): void {
    // prom-client's default registry is process-global: a second app in the same process (tests)
    // must not register the collectors again (duplicate-metric error).
    if (
      this.config.metricsEnabled &&
      register.getSingleMetric(DEFAULT_METRICS_SENTINEL) === undefined
    ) {
      collectDefaultMetrics({ eventLoopMonitoringPrecision: 10 });
    }
  }
}

/**
 * prom-client wiring (internal to `ObservabilityModule`): Node default metrics, the HTTP latency
 * histogram and `MetricsListener`, which serves `/metrics` on `METRICS_PORT` — not on the API port.
 * `@willsoto/nestjs-prometheus` is used only for `makeXProvider` / `@InjectMetric` (its module
 * always mounts a `/metrics` controller on the API, so it is not imported).
 *
 * No default `service` label: Prometheus attaches the scrape target's identity itself, and a second
 * `service` label would conflict with it (infra contract).
 */
@Module({
  providers: [
    makeHistogramProvider({
      name: HTTP_REQUEST_DURATION_SECONDS,
      help: 'HTTP server request duration in seconds, by method, route template and status code',
      labelNames: [...HTTP_METRIC_LABEL_NAMES],
      buckets: [...HTTP_DURATION_BUCKETS],
    }),
    HttpMetricsHook,
    ClusterMetricsWorkerBridge,
    DefaultMetricsCollector,
    MetricsListener,
  ],
  exports: [MetricsListener],
})
export class MetricsModule {}

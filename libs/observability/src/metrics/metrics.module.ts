import { type ObservabilityConfig, observabilityConfig } from '@app/config';
import { Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { makeHistogramProvider, PrometheusModule } from '@willsoto/nestjs-prometheus';
import { register } from 'prom-client';
import { enableClusterMetricsWorker } from './cluster-metrics.js';
import { HttpMetricsHook } from './http-metrics.hook.js';
import {
  DEFAULT_METRICS_SENTINEL,
  HTTP_DURATION_BUCKETS,
  HTTP_METRIC_LABEL_NAMES,
  HTTP_REQUEST_DURATION_SECONDS,
} from './metrics.constants.js';
import { MetricsController } from './metrics.controller.js';

/** Registers this worker with the primary's aggregator at boot (no-op outside cluster workers). */
@Injectable()
class ClusterMetricsWorkerBridge implements OnModuleInit {
  onModuleInit(): void {
    enableClusterMetricsWorker();
  }
}

/**
 * prom-client wiring (internal to `ObservabilityModule`): `/metrics`, Node default metrics
 * (`process_*`, `nodejs_*` — names used by the Grafana dashboard) and the HTTP latency histogram.
 *
 * No default `service` label: Prometheus attaches the scrape target's identity itself, and a second
 * `service` label would conflict with it (infra contract).
 */
@Module({
  imports: [
    PrometheusModule.registerAsync({
      // Global: `makeCounterProvider(...)` in any module resolves the (optional) prefix options.
      global: true,
      controller: MetricsController,
      inject: [observabilityConfig.KEY],
      useFactory: (config: ObservabilityConfig) => ({
        defaultMetrics: {
          // prom-client's default registry is process-global: a second app in the same process
          // (tests) must not register the collectors again (duplicate-metric error).
          enabled:
            config.metricsEnabled &&
            register.getSingleMetric(DEFAULT_METRICS_SENTINEL) === undefined,
          config: { eventLoopMonitoringPrecision: 10 },
        },
      }),
    }),
  ],
  providers: [
    makeHistogramProvider({
      name: HTTP_REQUEST_DURATION_SECONDS,
      help: 'HTTP server request duration in seconds, by method, route template and status code',
      labelNames: [...HTTP_METRIC_LABEL_NAMES],
      buckets: [...HTTP_DURATION_BUCKETS],
    }),
    HttpMetricsHook,
    ClusterMetricsWorkerBridge,
  ],
})
export class MetricsModule {}

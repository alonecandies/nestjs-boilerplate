import { appConfig, observabilityConfig } from '@platform/config';
import {
  collectClusterMetrics,
  type MetricsServer,
  startMetricsServer,
} from '@platform/observability';

/**
 * The cluster primary's metrics listener: the aggregate of every worker on `METRICS_PORT` (the
 * workers never bind it). Resolves `undefined` when `METRICS_ENABLED=false`; rejects when
 * `METRICS_PORT` equals `PORT` (the workers could never bind the API port). Config is parsed from the
 * environment: the primary has no Nest container.
 */
export async function startClusterPrimaryMetrics(
  env?: Parameters<typeof observabilityConfig.parse>[0],
): Promise<MetricsServer | undefined> {
  const observability = observabilityConfig.parse(env);
  if (!observability.metricsEnabled) return undefined;
  const app = appConfig.parse(env);
  if (observability.metricsPort !== 0 && observability.metricsPort === app.port) {
    throw new Error(
      `METRICS_PORT (${observability.metricsPort}) must differ from PORT (${app.port}): /metrics has its own listener`,
    );
  }
  return startMetricsServer({
    port: observability.metricsPort,
    host: app.host,
    bearerToken: observability.metricsBearerToken,
    collect: collectClusterMetrics,
  });
}

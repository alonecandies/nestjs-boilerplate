import cluster from 'node:cluster';
import { AggregatorRegistry, type PrometheusContentType } from 'prom-client';

/**
 * Cluster-wide metrics for `runClustered()` (node:cluster). Every worker has its own prom-client
 * registry; the PRIMARY serves `/metrics` on `METRICS_PORT` and collects every worker's registry over
 * prom-client's IPC (`AggregatorRegistry`: counters and histograms summed, gauges aggregated per
 * metric). Workers never open the metrics port.
 */
let workerEnabled = false;
let aggregator: AggregatorRegistry<PrometheusContentType> | undefined;

/**
 * WORKER: makes this worker's registry collectable by the primary. Must run at boot: the primary
 * asks EVERY worker, and one without a responder stalls the aggregation until prom-client's
 * timeout. Idempotent; a no-op outside cluster workers.
 */
export function enableClusterMetricsWorker(): void {
  if (workerEnabled || !cluster.isWorker) return;
  workerEnabled = true;
  // Constructing it installs prom-client's worker-side responder (`prom-client:getMetricsReq`).
  new AggregatorRegistry();
}

/** PRIMARY: the aggregated exposition text of every live worker (empty without workers). */
export function collectClusterMetrics(): Promise<string> {
  aggregator ??= new AggregatorRegistry<PrometheusContentType>();
  return aggregator.clusterMetrics();
}

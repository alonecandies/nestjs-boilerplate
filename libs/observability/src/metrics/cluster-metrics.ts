import cluster from 'node:cluster';
import { isObjectLike } from 'lodash-es';
import { AggregatorRegistry } from 'prom-client';

/**
 * Cluster-wide `/metrics` for `runClustered()` (node:cluster).
 *
 * Every worker has its own prom-client registry and the primary load-balances connections, so a
 * plain scrape returns ONE random worker's counters — rates jump around and totals are wrong. With
 * this bridge the worker that receives the scrape asks the primary over IPC, the primary collects
 * every worker's registry through prom-client's `AggregatorRegistry` (counters/histograms summed,
 * gauges aggregated per metric) and hands the result back. Same port, no extra metrics server.
 */
const REQUEST_TYPE = 'app:cluster-metrics:request';
const RESPONSE_TYPE = 'app:cluster-metrics:response';

/** Worker-side wait for the primary; prom-client's own primary-side timeout is 5 s. */
const DEFAULT_REQUEST_TIMEOUT_MS = 3_000;

interface ClusterMetricsRequest {
  type: typeof REQUEST_TYPE;
  id: number;
}

interface ClusterMetricsResponse {
  type: typeof RESPONSE_TYPE;
  id: number;
  metrics?: string;
  error?: string;
}

const isMessage = <T extends { type: string }>(value: unknown, type: T['type']): value is T =>
  isObjectLike(value) && (value as { type?: unknown }).type === type;

let primaryEnabled = false;
let workerEnabled = false;
let nextRequestId = 0;
const pendingRequests = new Map<number, (response: ClusterMetricsResponse) => void>();

/**
 * PRIMARY: answers workers' scrape requests with the aggregated metrics of all workers. Idempotent;
 * a no-op outside a cluster primary. Called by `@app/bootstrap`'s `runClustered()`.
 */
export function enableClusterMetricsAggregation(): void {
  if (primaryEnabled || !cluster.isPrimary) return;
  primaryEnabled = true;
  const aggregator = new AggregatorRegistry();
  cluster.on('message', (worker, message: unknown) => {
    if (!isMessage<ClusterMetricsRequest>(message, REQUEST_TYPE)) return;
    aggregator.clusterMetrics().then(
      (metrics) => worker.send({ type: RESPONSE_TYPE, id: message.id, metrics }),
      (error: unknown) =>
        worker.send({
          type: RESPONSE_TYPE,
          id: message.id,
          error: error instanceof Error ? error.message : String(error),
        }),
    );
  });
}

/**
 * WORKER: makes this worker's registry collectable by the primary and listens for aggregated
 * responses. Must run at boot (not on first scrape): the primary asks EVERY worker, and one without
 * a listener stalls the aggregation until prom-client's timeout. Idempotent; no-op outside workers.
 */
export function enableClusterMetricsWorker(): void {
  if (workerEnabled || !cluster.isWorker) return;
  workerEnabled = true;
  // Constructing it installs prom-client's worker-side responder (`prom-client:getMetricsReq`).
  new AggregatorRegistry();
  process.on('message', (message: unknown) => {
    if (!isMessage<ClusterMetricsResponse>(message, RESPONSE_TYPE)) return;
    pendingRequests.get(message.id)?.(message);
  });
}

/**
 * WORKER: the cluster-wide metrics text, or `undefined` when not in a cluster worker, when the
 * primary doesn't answer in time, or on error — callers then serve their local registry.
 */
export function requestClusterMetrics(
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<string | undefined> {
  const send = process.send?.bind(process);
  if (!cluster.isWorker || !workerEnabled || send === undefined) {
    return Promise.resolve(undefined);
  }
  const id = ++nextRequestId;
  return new Promise((resolve) => {
    const settle = (metrics: string | undefined): void => {
      clearTimeout(timer);
      pendingRequests.delete(id);
      resolve(metrics);
    };
    const timer = setTimeout(() => settle(undefined), timeoutMs);
    timer.unref();
    pendingRequests.set(id, (response) =>
      settle(response.error === undefined ? response.metrics : undefined),
    );
    const request: ClusterMetricsRequest = { type: REQUEST_TYPE, id };
    send(request);
  });
}

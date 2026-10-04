/** Histogram consumed by the Grafana dashboard (infra contract): `{method, route, status_code}`. */
export const HTTP_REQUEST_DURATION_SECONDS = 'http_request_duration_seconds';

/** RED-latency buckets (seconds): 5 ms … 5 s — beyond that the request timeout (30 s) dominates anyway. */
export const HTTP_DURATION_BUCKETS: readonly number[] = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5,
];

export const HTTP_METRIC_LABEL_NAMES = ['method', 'route', 'status_code'] as const;

/** `route` label of requests that matched no route (404s, scanners) — one series, not one per URL. */
export const UNMATCHED_ROUTE = 'UNMATCHED';

/** Where Prometheus scrapes (VERSION_NEUTRAL, excluded from its own latency histogram). */
export const METRICS_PATH = '/metrics';

/** A default metric prom-client registers first; its presence means default metrics already run. */
export const DEFAULT_METRICS_SENTINEL = 'process_cpu_user_seconds_total';

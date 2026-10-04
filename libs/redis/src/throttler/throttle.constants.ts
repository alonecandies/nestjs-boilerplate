/** Name of the single configured throttler (`THROTTLE_TTL_MS` / `THROTTLE_LIMIT`). */
export const DEFAULT_THROTTLER_NAME = 'default';

/** Route metadata set by `@AuthThrottle()` (read by `AppThrottlerGuard`). */
export const AUTH_THROTTLE_KEY = 'app:authThrottle';

/**
 * Ops endpoints that must never be rate limited: probes and scrapers hit them constantly from a
 * handful of IPs, and a 429 on `/health/ready` would take the pod out of rotation. Matched as path
 * prefixes on a `/` boundary (`/health` covers `/health/live`, not `/healthz`).
 */
export const DEFAULT_THROTTLE_EXEMPT_PATHS: readonly string[] = [
  '/health',
  '/metrics',
  '/docs',
  '/openapi.json',
  '/openapi.yaml',
  '/swagger',
];

/**
 * Named throttlers (spec §11). Each guard enforces its own subset (`RateLimitGuardBase.enforced`):
 * `ip` before authentication, `user`/`tenant`/`route`/`auth` after it, `user`/`tenant`/`route` per
 * WebSocket message.
 * `lockout` is a bucket the `auth` throttler maintains, not a configured throttler.
 */
export const THROTTLER = {
  IP: 'ip',
  USER: 'user',
  TENANT: 'tenant',
  ROUTE: 'route',
  AUTH: 'auth',
  LOCKOUT: 'lockout',
  /** GraphQL cost budget, charged per operation by `OperationRateLimitPlugin` (not a guard throttler). */
  GRAPHQL: 'graphql',
} as const;

export type ThrottlerName = (typeof THROTTLER)[keyof typeof THROTTLER];

/** Every configured throttler name: `SkipRateLimit()` skips all of them. */
export const RATE_LIMIT_THROTTLERS: readonly ThrottlerName[] = Object.freeze([
  THROTTLER.IP,
  THROTTLER.USER,
  THROTTLER.TENANT,
  THROTTLER.ROUTE,
  THROTTLER.AUTH,
]);

/** Scope of the budgets that span every route (`ip`, `user`). */
export const GLOBAL_SCOPE = 'global';

/** Route metadata set by `@RateLimit(policy)` (read by `RateLimitGuardBase`). */
export const RATE_LIMIT_POLICY_KEY = 'app:rateLimitPolicy';

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

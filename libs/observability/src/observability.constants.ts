/** `ResolvedHealthOptions` — readiness settings resolved by `ObservabilityModule.forRoot`. */
export const HEALTH_OPTIONS = Symbol('HEALTH_OPTIONS');

/** Per-contributor readiness timeout: a hung dependency must not hang the probe (k8s default timeout is 1s–5s). */
export const DEFAULT_READINESS_TIMEOUT_MS = 3_000;

/** Paths whose request/response lines are never auto-logged (probes and scrapes every few seconds). */
export const QUIET_LOG_PATH_PREFIXES: readonly string[] = ['/health', '/metrics'];

/** CLS key of the authenticated user id (set by auth guards / gRPC context interceptors). */
export const CLS_USER_ID = Symbol('app:userId');

/** CLS key of the caller-supplied correlation id (`x-correlation-id`), when valid. */
export const CLS_CORRELATION_ID = Symbol('app:correlationId');

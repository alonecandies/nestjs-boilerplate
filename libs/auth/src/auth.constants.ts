/** Route metadata written by `@Roles()` (read by `RolesGuard`). */
export const ROLES_KEY = 'auth:roles';

/** Route metadata written by `@RequirePermissions()` / `@RequireAnyPermission()`. */
export const PERMISSIONS_KEY = 'auth:permissions';

/** Passport strategy names. */
export const JWT_STRATEGY = 'jwt';
export const LOCAL_STRATEGY = 'local';

/** Symmetric HMAC — every service verifies locally with the shared secret (no RPC per request). */
export const JWT_ALGORITHM = 'HS256';

/**
 * Accepted clock skew between the issuing service and verifiers (seconds). Also added to the
 * denylist TTL so a revoked token can't slip through in the tolerance window.
 */
export const JWT_CLOCK_TOLERANCE_SEC = 5;

/**
 * Upper bound on the denylist EXISTS run by every authenticated request (it runs in the guard,
 * before `TimeoutInterceptor`). During a Redis outage ioredis parks commands in its offline queue
 * for up to `maxRetriesPerRequest` reconnect attempts; this bound fails closed (503) after 250 ms
 * instead, while still riding out sub-second reconnect blips.
 */
export const DENYLIST_CHECK_TIMEOUT_MS = 250;

/**
 * Stable `code`s of the auth-specific `UnauthenticatedException`s, so clients can react (e.g.
 * refresh on `TOKEN_EXPIRED`, re-login on `TOKEN_REVOKED`). The HTTP status stays 401.
 */
export const AuthErrorCode = {
  MISSING_TOKEN: 'MISSING_TOKEN',
  INVALID_TOKEN: 'INVALID_TOKEN',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_REVOKED: 'TOKEN_REVOKED',
  MISSING_CREDENTIALS: 'MISSING_CREDENTIALS',
} as const;
export type AuthErrorCode = (typeof AuthErrorCode)[keyof typeof AuthErrorCode];

/** Route metadata written by `@StaffOnly()` (also read by docs and the B2-23 gRPC edge). */
export const STAFF_ONLY_KEY = 'auth:staff-only';

/** Stable `code`s of RBAC 403s that clients act on. */
export const RbacErrorCode = {
  /** The route needs a platform-staff switch-in token (`@StaffOnly()`). */
  STAFF_ONLY: 'STAFF_ONLY',
} as const;
export type RbacErrorCode = (typeof RbacErrorCode)[keyof typeof RbacErrorCode];

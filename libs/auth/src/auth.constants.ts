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

/** Longest password accepted for hashing/verification (argon2 cost DoS guard). */
export const MAX_PASSWORD_LENGTH = 1_024;

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

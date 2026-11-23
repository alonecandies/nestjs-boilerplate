/**
 * Limits shared by every entry point (REST DTOs, GraphQL inputs, gRPC zod schemas, the aggregate)
 * so a request accepted by one transport is accepted by all of them.
 */
export const IDENTITY_LIMITS = {
  /** RFC 5321 path limit. */
  EMAIL_MAX_LENGTH: 254,
  PASSWORD_MIN_LENGTH: 8,
  /** Argon2 cost grows with input length: stay well below `MAX_PASSWORD_LENGTH` (1024). */
  PASSWORD_MAX_LENGTH: 128,
  DISPLAY_NAME_MIN_LENGTH: 1,
  DISPLAY_NAME_MAX_LENGTH: 100,
  /** pg_trgm indexes trigrams: a shorter `ILIKE '%q%'` term cannot use `users_search_trgm_idx`. */
  SEARCH_MIN_LENGTH: 3,
  SEARCH_MAX_LENGTH: 100,
  /** A signed refresh JWT is ~300 bytes; anything much larger is garbage. */
  REFRESH_TOKEN_MAX_LENGTH: 4096,
  /** Upper bound of one `GetUsersByIds` batch (= DataLoader `maxBatchSize`). */
  USERS_BATCH_MAX: 500,
  /** Stored client fingerprint (sessions.user_agent / sessions.ip) is truncated to these. */
  USER_AGENT_MAX_LENGTH: 512,
  IP_MAX_LENGTH: 64,
  /** identity.tenants.name (personal workspace names are cut to fit). */
  TENANT_NAME_MAX_LENGTH: 100,
  /** Staff switch-in reason, after trimming (spec §5.2: audited free text). */
  SWITCH_IN_REASON_MAX_LENGTH: 1_000,
} as const;

/** Longest password `PasswordHasher` hashes or verifies (argon2 cost DoS guard, any transport). */
export const MAX_PASSWORD_LENGTH = 1_024;

/** Stable machine codes of identity errors (`ProblemDetails.code`, gRPC `x-error-code`, GraphQL `extensions.code`). */
export const IdentityErrorCode = {
  EMAIL_TAKEN: 'EMAIL_TAKEN',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  INVALID_REFRESH_TOKEN: 'INVALID_REFRESH_TOKEN',
  REFRESH_TOKEN_REUSED: 'REFRESH_TOKEN_REUSED',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  INVALID_ROLES: 'INVALID_ROLES',
  INVALID_USER: 'INVALID_USER',
  TENANT_SLUG_TAKEN: 'TENANT_SLUG_TAKEN',
  MEMBERSHIP_EXISTS: 'MEMBERSHIP_EXISTS',
  TENANT_ACCESS_DENIED: 'TENANT_ACCESS_DENIED',
  MEMBERSHIP_REVOKED: 'MEMBERSHIP_REVOKED',
  GLOBAL_ROLES_REMOVED: 'GLOBAL_ROLES_REMOVED',
  STAFF_TOKEN_NOT_ALLOWED: 'STAFF_TOKEN_NOT_ALLOWED',
  STAFF_ONLY: 'STAFF_ONLY',
  LAST_OWNER: 'LAST_OWNER',
  OWNER_RANK_REQUIRED: 'OWNER_RANK_REQUIRED',
  INVITATION_INVALID: 'INVITATION_INVALID',
  INVITATION_EMAIL_MISMATCH: 'INVITATION_EMAIL_MISMATCH',
} as const;
export type IdentityErrorCode = (typeof IdentityErrorCode)[keyof typeof IdentityErrorCode];

/** DataLoader name registered by the identity Api module (`@Loader(USERS_LOADER)` in the apps' `PaymentUserFieldResolver`). */
export const USERS_LOADER = 'users';

/** Read-through cache of `GET /v1/users/:id` (blueprint §3.16): key `user:{id}`, 30 s. */
export const USER_CACHE_TTL_MS = 30_000;
export const userCacheKey = (id: string): string => `user:${id}`;
/** The `cache` label of the user read cache in `cache_requests_total`. */
export const USER_CACHE_NAME = 'user';

/** Hourly purge of expired sessions, on one replica only (`@WithLock`). */
export const PURGE_SESSIONS_LOCK = 'identity:purge-sessions';
export const PURGE_SESSIONS_LOCK_TTL_MS = 60_000;

/** `AuthTokens.tokenType` (OAuth2 `token_type`). */
export const BEARER_TOKEN_TYPE = 'Bearer';

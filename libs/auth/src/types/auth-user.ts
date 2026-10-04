import type { Permission } from '../rbac/permission.enum.js';
import type { Role } from '../rbac/role.enum.js';

/**
 * The authenticated principal attached to `req.user` (HTTP / GraphQL) and `socket.data.user` (WS).
 * Built from verified access-token claims only — no DB lookup per request.
 */
export interface AuthUser {
  id: string;
  email: string;
  roles: Role[];
  /** Resolved from `roles` via `ROLE_PERMISSIONS` when the token is verified. */
  permissions: Permission[];
  /** Access-token id (uuidv7) — what logout puts on the denylist. */
  jti: string;
  /** Access-token expiry, epoch seconds. */
  exp: number;
}

export type TokenType = 'access' | 'refresh';

/** Registered + private claims of an access token (short-lived, verified at the edge). */
export interface AccessTokenClaims {
  sub: string;
  email: string;
  roles: Role[];
  jti: string;
  typ: 'access';
  iat: number;
  exp: number;
  iss: string;
  aud: string;
}

/** Claims of a refresh token (long-lived, separate secret). `jti` is the session id. */
export interface RefreshTokenClaims {
  sub: string;
  jti: string;
  typ: 'refresh';
  iat: number;
  exp: number;
  iss: string;
  aud: string;
}

/** What `TokenService.issueAccessToken` needs to know about the user. */
export interface AccessTokenSubject {
  id: string;
  email: string;
  roles: readonly Role[];
}

export interface IssuedAccessToken {
  token: string;
  jti: string;
  /** Lifetime in seconds (OAuth2 `expires_in`). */
  expiresIn: number;
  /** Expiry, epoch seconds. */
  exp: number;
}

export interface IssuedRefreshToken {
  token: string;
  expiresAt: Date;
}

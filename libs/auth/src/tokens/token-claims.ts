import {
  isPlatformTenantId,
  isTenantRole,
  isUuid,
  normalizeTenantRoles,
  UnauthenticatedException,
} from '@platform/common';
import { isArray, isInteger, isString } from 'lodash-es';
import { AuthErrorCode } from '../auth.constants.js';
import { isPermissionName } from '../rbac/rbac-feature.js';
import type {
  AccessTokenClaims,
  AuthUser,
  RefreshTokenClaims,
  TokenType,
} from '../types/auth-user.js';

const invalid = (reason: string): UnauthenticatedException =>
  new UnauthenticatedException('Invalid token', {
    code: AuthErrorCode.INVALID_TOKEN,
    details: { reason },
  });

const nonEmpty = (value: unknown): value is string => isString(value) && value.length > 0;

type ClaimsRecord = Record<string, unknown>;

/** Registered claims shared by both token types (signature/iss/aud/exp already verified by jwt). */
function parseBase(
  payload: unknown,
  typ: TokenType,
): ClaimsRecord & {
  sub: string;
  jti: string;
  iat: number;
  exp: number;
  iss: string;
  aud: string;
} {
  if (typeof payload !== 'object' || payload === null) throw invalid('payload is not an object');
  const claims = payload as ClaimsRecord;
  // Access and refresh tokens use different secrets AND a `typ` claim: a refresh token can
  // never be replayed as an access token even if the secrets were misconfigured to be equal.
  if (claims.typ !== typ) throw invalid(`expected a ${typ} token`);
  const { sub, jti, iat, exp, iss, aud } = claims;
  if (!nonEmpty(sub) || !nonEmpty(jti)) throw invalid('missing sub/jti');
  if (!isInteger(iat) || !isInteger(exp)) throw invalid('missing iat/exp');
  if (!nonEmpty(iss) || !nonEmpty(aud)) throw invalid('missing iss/aud');
  return { ...claims, sub, jti, iat: iat as number, exp: exp as number, iss, aud };
}

/**
 * Validates the shape of verified access-token claims. `tid` is required (a pre-B2 token has none:
 * 401 and the client refreshes). Unknown roles are DROPPED rather than rejected: during a rolling
 * deploy a newer issuer may know roles this service doesn't — least privilege, without locking those
 * users out. `staff` is true only for the JSON boolean `true`. UUID ids are lower-cased so that
 * every later string comparison and `SET LOCAL` sees one spelling.
 */
export function parseAccessTokenClaims(payload: unknown): AccessTokenClaims {
  const base = parseBase(payload, 'access');
  const { email, roles, tid, staff } = base;
  if (!isString(email)) throw invalid('missing email');
  if (!Array.isArray(roles)) throw invalid('missing roles');
  if (isPlatformTenantId(tid)) throw invalid('tid is the platform tenant');
  if (!isString(tid) || !isUuid(tid)) throw invalid('missing or malformed tid');
  return {
    sub: isUuid(base.sub) ? base.sub.toLowerCase() : base.sub,
    email,
    tid: tid.toLowerCase(),
    roles: normalizeTenantRoles(roles),
    staff: staff === true,
    jti: base.jti,
    typ: 'access',
    iat: base.iat,
    exp: base.exp,
    iss: base.iss,
    aud: base.aud,
  };
}

export function parseRefreshTokenClaims(payload: unknown): RefreshTokenClaims {
  const base = parseBase(payload, 'refresh');
  return {
    sub: base.sub,
    jti: base.jti,
    typ: 'refresh',
    iat: base.iat,
    exp: base.exp,
    iss: base.iss,
    aud: base.aud,
  };
}

/** Builds `req.user` from verified claims and the permissions their roles resolve to. */
export function toAuthUser(claims: AccessTokenClaims, permissions: readonly string[]): AuthUser {
  return {
    id: claims.sub,
    email: claims.email,
    tenantId: claims.tid,
    roles: [...claims.roles],
    staff: claims.staff,
    permissions: [...permissions],
    jti: claims.jti,
    exp: claims.exp,
  };
}

/** Structural guard for `req.user` / `socket.data.user` (untyped at the transport layer). */
export function isAuthUser(value: unknown): value is AuthUser {
  if (typeof value !== 'object' || value === null) return false;
  const user = value as ClaimsRecord;
  return (
    nonEmpty(user.id) &&
    isString(user.email) &&
    nonEmpty(user.tenantId) &&
    isArray(user.roles) &&
    user.roles.every(isTenantRole) &&
    typeof user.staff === 'boolean' &&
    isArray(user.permissions) &&
    user.permissions.every(isPermissionName) &&
    isString(user.jti) &&
    isInteger(user.exp)
  );
}

import { UnauthenticatedException } from '@app/common';
import { isArray, isInteger, isString } from 'lodash-es';
import { AuthErrorCode } from '../auth.constants.js';
import { isPermission } from '../rbac/permission.enum.js';
import { isRole } from '../rbac/role.enum.js';
import { resolvePermissions } from '../rbac/role-permissions.js';
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
 * Validates the shape of verified access-token claims. Unknown roles are DROPPED rather than
 * rejected: during a rolling deploy a newer issuer may know roles this service doesn't — least
 * privilege, without locking those users out.
 */
export function parseAccessTokenClaims(payload: unknown): AccessTokenClaims {
  const base = parseBase(payload, 'access');
  const { email, roles } = base;
  if (!isString(email)) throw invalid('missing email');
  if (!isArray(roles)) throw invalid('missing roles');
  return {
    sub: base.sub,
    email,
    roles: roles.filter(isRole),
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

/** Builds `req.user` from verified claims (permissions resolved from roles, once per request). */
export function toAuthUser(claims: AccessTokenClaims): AuthUser {
  return {
    id: claims.sub,
    email: claims.email,
    roles: [...claims.roles],
    permissions: resolvePermissions(claims.roles),
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
    isArray(user.roles) &&
    user.roles.every(isRole) &&
    isArray(user.permissions) &&
    user.permissions.every(isPermission) &&
    isString(user.jti) &&
    isInteger(user.exp)
  );
}

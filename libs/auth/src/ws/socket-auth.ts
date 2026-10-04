import { UnauthenticatedException } from '@app/common';
import { isString } from 'lodash-es';
import { AuthErrorCode } from '../auth.constants.js';
import type { AccessTokenDenylist } from '../tokens/access-token-denylist.service.js';
import type { TokenService } from '../tokens/token.service.js';
import type { AuthUser } from '../types/auth-user.js';

const BEARER = /^Bearer\s+(\S+)\s*$/i;

/** Accepts a raw JWT or `Bearer <jwt>`; anything else → `undefined`. */
export function extractBearerToken(value: unknown): string | undefined {
  if (!isString(value)) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const match = BEARER.exec(trimmed);
  if (match) return match[1];
  return /\s/.test(trimmed) ? undefined : trimmed;
}

/** The parts of a socket.io handshake we read (typed structurally → no socket.io dependency). */
export interface HandshakeLike {
  auth?: Record<string, unknown>;
  headers?: Record<string, string | string[] | undefined>;
}

/**
 * Token of a socket.io connection: `io(url, { auth: { token } })` (browser-friendly) first, then
 * the `Authorization` header (server-to-server clients). Query-string tokens are deliberately NOT
 * supported (they leak into access logs).
 */
export function extractSocketToken(handshake: HandshakeLike | undefined): string | undefined {
  const header = handshake?.headers?.authorization;
  return (
    extractBearerToken(handshake?.auth?.token) ??
    extractBearerToken(Array.isArray(header) ? header[0] : header)
  );
}

/**
 * Authenticates a WebSocket once, at connection time (`handleConnection` / namespace middleware):
 * verifies the access token and the denylist, and returns the `AuthUser` to store in
 * `socket.data.user` (read afterwards by `JwtAuthGuard`, `@CurrentUser()` and the throttler).
 * Throws `UnauthenticatedException` — emit it and disconnect the socket.
 */
export async function authenticateSocket(
  tokenService: TokenService,
  denylist: AccessTokenDenylist,
  token: unknown,
): Promise<AuthUser> {
  const raw = extractBearerToken(token);
  if (!raw) {
    throw new UnauthenticatedException('Missing access token', {
      code: AuthErrorCode.MISSING_TOKEN,
    });
  }
  const claims = await tokenService.verifyAccessToken(raw);
  if (await denylist.isDenied(claims.jti)) {
    throw new UnauthenticatedException('Token has been revoked', {
      code: AuthErrorCode.TOKEN_REVOKED,
    });
  }
  return tokenService.toAuthUser(claims);
}

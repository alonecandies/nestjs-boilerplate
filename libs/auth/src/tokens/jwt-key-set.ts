import { createHmac, timingSafeEqual } from 'node:crypto';
import type { JwtSignOptions } from '@nestjs/jwt';
import { UnauthenticatedException } from '@platform/common';
import type { AuthConfig, JwtVerifyKey } from '@platform/config';
import { AuthErrorCode, JWT_ALGORITHM } from '../auth.constants.js';

/**
 * The HS256 keys of one token type (SEC-1): the signing secret with its optional key id, and the
 * verify-only keys of a rotation window. Access tokens: `accessKeySet(authConfig)`; refresh tokens:
 * identity's `refreshToken` namespace.
 */
export interface JwtKeySet {
  readonly signingSecret: string;
  /** Written as the `kid` header when set. */
  readonly signingKeyId: string | undefined;
  readonly verifyOnly: readonly JwtVerifyKey[];
}

/** The access-token key set of the platform `auth` namespace. */
export function accessKeySet(
  config: Pick<AuthConfig, 'accessSecret' | 'accessKeyId' | 'accessVerifyKeys'>,
): JwtKeySet {
  return {
    signingSecret: config.accessSecret,
    signingKeyId: config.accessKeyId,
    verifyOnly: config.accessVerifyKeys,
  };
}

/** `secret` and, when the key has an id, `keyid` (the `kid` header) for `JwtService.sign*`. */
export function jwtSigningKey(
  keySet: Pick<JwtKeySet, 'signingSecret' | 'signingKeyId'>,
): Pick<JwtSignOptions, 'secret' | 'keyid'> {
  // jsonwebtoken refuses `keyid: undefined`, so the option is left out when there is no id.
  return keySet.signingKeyId === undefined
    ? { secret: keySet.signingSecret }
    : { secret: keySet.signingSecret, keyid: keySet.signingKeyId };
}

const unknownKeyId = (): UnauthenticatedException =>
  // Never the kid itself: it is attacker-chosen text, and key ids stay out of logs.
  new UnauthenticatedException('Invalid token', {
    code: AuthErrorCode.INVALID_TOKEN,
    details: { reason: 'unknown key id' },
  });

/** The decoded JOSE header, or undefined when the token is not three base64url JSON parts. */
function headerOf(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const header: unknown = JSON.parse(Buffer.from(parts[0] ?? '', 'base64url').toString('utf8'));
    return typeof header === 'object' && header !== null && !Array.isArray(header)
      ? (header as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Constant-time HS256 signature check, used only to pick the key; jsonwebtoken verifies after. */
function signedWith(token: string, secret: string): boolean {
  const [head, body, signature] = token.split('.') as [string, string, string];
  const expected = createHmac('sha256', secret).update(`${head}.${body}`).digest();
  const actual = Buffer.from(signature, 'base64url');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * The one secret a token may verify with, for every verifier (the passport strategy,
 * `TokenService`, identity's refresh verification):
 * - a `kid` the set knows (the signing key id or a verify-only one) selects that key only;
 * - any other `kid` is refused (`INVALID_TOKEN`), even when a listed key would match: an unknown
 *   key id never falls back to trying every key;
 * - no `kid`: the signing key, then each verify-only key, in order; the first whose HS256
 *   signature matches is returned. When none matches (or the token is malformed, or not HS256)
 *   the signing key is returned, and jsonwebtoken reports the failure.
 *
 * The caller still verifies with jsonwebtoken (signature, algorithm, `iss`, `aud`, `exp`), so an
 * expired token signed with a verify-only key stays `TOKEN_EXPIRED`.
 */
export function resolveVerificationSecret(token: string, keySet: JwtKeySet): string {
  const header = headerOf(token);
  if (header === undefined) return keySet.signingSecret;
  if (header.kid !== undefined) {
    const kid = header.kid;
    if (keySet.signingKeyId !== undefined && kid === keySet.signingKeyId) {
      return keySet.signingSecret;
    }
    const key = keySet.verifyOnly.find((candidate) => candidate.kid === kid);
    if (key === undefined) throw unknownKeyId();
    return key.secret;
  }
  if (keySet.verifyOnly.length === 0 || header.alg !== JWT_ALGORITHM) return keySet.signingSecret;
  for (const secret of [keySet.signingSecret, ...keySet.verifyOnly.map((key) => key.secret)]) {
    if (signedWith(token, secret)) return secret;
  }
  return keySet.signingSecret;
}

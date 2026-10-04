import { hash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Hex SHA-256. Uses the one-shot `crypto.hash` (Node ≥ 21.7), ~2x faster than
 * `createHash().update().digest()` for small inputs such as refresh tokens.
 */
export function sha256Hex(input: string | Buffer | Uint8Array): string {
  return hash('sha256', input, 'hex');
}

/**
 * Constant-time string comparison. Both sides are hashed first so the comparison length is fixed
 * and neither the content nor the LENGTH of the secret leaks through timing.
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  return timingSafeEqual(hash('sha256', a, 'buffer'), hash('sha256', b, 'buffer'));
}

/** URL-safe random token (default 32 bytes = 256 bits of entropy → 43 chars). */
export function randomTokenBase64Url(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

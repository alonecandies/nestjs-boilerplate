import { createHash } from 'node:crypto';

/** RFC 5321 caps a mailbox at 254-320 octets; longer values are never valid identifiers. */
const MAX_CREDENTIAL_LENGTH = 320;

/** `' Alice@X.com'` → `'alice@x.com'` (NFKC, trimmed, lower-cased); non-strings → `undefined`. */
export function normalizeCredential(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.normalize('NFKC').trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > MAX_CREDENTIAL_LENGTH) return undefined;
  return normalized;
}

/**
 * sha256 of the normalised credential (no email reaches Redis). Requests without a usable
 * credential share the `'none'` tracker, so malformed bodies are still limited per IP.
 */
export function credentialHash(value: unknown): string {
  const normalized = normalizeCredential(value);
  return normalized === undefined ? 'none' : createHash('sha256').update(normalized).digest('hex');
}

/** `field` of an HTTP body, or of GraphQL args (`{ input: { email } }` or flat `{ email }`). */
export function credentialFrom(source: unknown, field: string): unknown {
  if (typeof source !== 'object' || source === null) return undefined;
  const direct: unknown = Reflect.get(source, field);
  if (direct !== undefined) return direct;
  const input: unknown = Reflect.get(source, 'input');
  return typeof input === 'object' && input !== null ? Reflect.get(input, field) : undefined;
}

import { DomainValidationException, toSafeFilename } from '@app/common';
import { clamp, compact, isEmpty, map, some, trim } from 'lodash-es';

/** S3's hard limit on key length (UTF-8 bytes); GCS allows the same. */
export const MAX_STORAGE_KEY_BYTES = 1024;

/** S3 and GCS v4 signatures both cap presigned URL lifetime at 7 days. */
export const MAX_SIGNED_URL_TTL_SEC = 604_800;

export const INVALID_STORAGE_KEY = 'INVALID_STORAGE_KEY';

// Control characters (incl. DEL) break signatures/logs; backslashes are path separators for some clients.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const FORBIDDEN_KEY_CHARS = /[\u0000-\u001f\u007f\\]/;

function invalidKey(reason: string): DomainValidationException {
  return new DomainValidationException(`Invalid storage key: ${reason}`, {
    code: INVALID_STORAGE_KEY,
    issues: [{ path: 'key', message: reason }],
  });
}

/**
 * Validates an object key and returns it unchanged. Keys are authorization boundaries here
 * (ownership = key prefix, e.g. `users/{id}/…`), so ambiguous shapes are rejected outright:
 * leading `/`, empty or `.`/`..` segments, control characters, backslashes, > 1024 bytes.
 *
 * @throws DomainValidationException `INVALID_STORAGE_KEY`
 */
export function assertStorageKey(key: string): string {
  if (isEmpty(key)) throw invalidKey('must not be empty');
  if (Buffer.byteLength(key, 'utf8') > MAX_STORAGE_KEY_BYTES) {
    throw invalidKey(`must be at most ${MAX_STORAGE_KEY_BYTES} bytes`);
  }
  if (FORBIDDEN_KEY_CHARS.test(key)) throw invalidKey('contains control characters or "\\"');
  if (some(key.split('/'), (segment) => segment === '' || segment === '.' || segment === '..')) {
    throw invalidKey('must not contain empty, "." or ".." segments (or a leading/trailing "/")');
  }
  return key;
}

/**
 * Joins trimmed, non-empty segments with `/` and validates the result:
 * `buildStorageKey('users', userId, `${generateId()}-${toSafeFilename(name)}`)`.
 * Segments are NOT sanitized (only validated) — pass user input through `toSafeFilename` first.
 */
export function buildStorageKey(...segments: readonly (string | number)[]): string {
  return assertStorageKey(compact(map(segments, (s) => trim(String(s)))).join('/'));
}

/** `true` when `key` lies strictly under the `prefix` "directory" (prefix given without trailing `/`). */
export function isKeyWithinPrefix(key: string, prefix: string): boolean {
  return key.startsWith(`${prefix}/`) && key.length > prefix.length + 1;
}

// RFC 5987 attr-char excludes these, but encodeURIComponent leaves them as-is.
const RFC5987_EXTRA = /['()*]/g;

/**
 * `Content-Disposition` forcing a download: an ASCII-safe `filename` fallback for old clients plus
 * the exact UTF-8 name in `filename*` (RFC 6266 / RFC 5987). Path components and control
 * characters are stripped so the header can't be split or point elsewhere.
 */
export function attachmentContentDisposition(filename: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point.
  const original = (filename.split(/[/\\]/).pop() ?? '').replaceAll(/[\u0000-\u001f\u007f"]/g, '');
  const ascii = toSafeFilename(original);
  const encoded = encodeURIComponent(original || ascii).replaceAll(
    RFC5987_EXTRA,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** Requested presign TTL (or the configured default), clamped to what S3/GCS accept. */
export function resolveSignedUrlTtlSec(requested: number | undefined, fallback: number): number {
  return clamp(Math.floor(requested ?? fallback), 1, MAX_SIGNED_URL_TTL_SEC);
}

/** Strips the quotes S3/GCS put around entity tags. */
export function unquoteEtag(etag: string | undefined): string | undefined {
  return etag === undefined ? undefined : trim(etag, '"');
}

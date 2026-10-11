import { trim } from 'lodash-es';
import {
  ALLOWED_UPLOAD_CONTENT_TYPE_PATTERN,
  type AllowedUploadContentType,
} from '../files.constants.js';
import { UnsupportedFileTypeException } from './files.errors.js';

/**
 * Canonical form of a media type for the allow-list check and for storage: trimmed and
 * lower-cased (media types are case-insensitive, and the signed `Content-Type` of a presigned
 * upload must be byte-identical to what the client then sends). Parameters are NOT stripped, so
 * `text/plain; charset=utf-8` is rejected rather than silently rewritten.
 */
export function normalizeContentType(contentType: string): string {
  return trim(contentType).toLowerCase();
}

const isAllowedNormalized = (value: string): value is AllowedUploadContentType =>
  ALLOWED_UPLOAD_CONTENT_TYPE_PATTERN.test(value);

export function isAllowedContentType(contentType: string): boolean {
  return isAllowedNormalized(normalizeContentType(contentType));
}

/**
 * Returns the normalized content type when it is allowed.
 *
 * @throws UnsupportedFileTypeException (415) otherwise
 */
export function assertAllowedContentType(contentType: string): AllowedUploadContentType {
  const normalized = normalizeContentType(contentType);
  if (!isAllowedNormalized(normalized)) throw new UnsupportedFileTypeException(contentType);
  return normalized;
}

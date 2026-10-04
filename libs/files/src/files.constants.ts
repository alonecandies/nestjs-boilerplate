import { escapeRegExp } from 'lodash-es';

/** Root "directory" of per-user objects: keys are `users/{userId}/{uuidv7}-{safeFilename}`. */
export const USER_FILES_ROOT = 'users';

/** Multipart field that carries the file on `POST /v1/files`. */
export const UPLOAD_FILE_FIELD = 'file';

/** Longest client-supplied filename accepted (it is sanitized and capped to 120 chars in the key). */
export const MAX_FILENAME_LENGTH = 255;

/**
 * Hard ceiling for presigned uploads, whatever `STORAGE_MAX_UPLOAD_BYTES` says: a presigned URL is a
 * single `PUT`, and S3 rejects single-part uploads over 5 GiB.
 */
export const MAX_PRESIGNED_UPLOAD_BYTES = 5 * 1024 ** 3;

/**
 * Accepted content types (lower-case, no parameters), for streamed and presigned uploads alike.
 * Deliberately absent: `image/svg+xml` and `text/html` (script-capable, stored XSS if ever served
 * inline) and executables. Downloads are always presigned with `Content-Disposition: attachment`
 * on top of that.
 */
export const ALLOWED_UPLOAD_CONTENT_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'application/pdf',
  'application/json',
  'application/zip',
  'text/plain',
  'text/csv',
  'audio/mpeg',
  'video/mp4',
] as const;

export type AllowedUploadContentType = (typeof ALLOWED_UPLOAD_CONTENT_TYPES)[number];

/** `ALLOWED_UPLOAD_CONTENT_TYPES` as an anchored regex (zod `.regex()`, class-validator `@Matches`). */
export const ALLOWED_UPLOAD_CONTENT_TYPE_PATTERN = new RegExp(
  `^(?:${ALLOWED_UPLOAD_CONTENT_TYPES.map(escapeRegExp).join('|')})$`,
);

import {
  DomainException,
  type DomainExceptionOptions,
  EntityNotFoundException,
  PermissionDeniedException,
  ServiceUnavailableException,
  type ValidationIssue,
} from '@app/common';
import { HttpStatus } from '@nestjs/common';
import { truncate } from 'lodash-es';

const MAX_ECHOED_CONTENT_TYPE_LENGTH = 100;

/** Stable error codes of the files context (part of the public API — never rename one). */
export const FilesErrorCode = {
  FILE_ACCESS_DENIED: 'FILE_ACCESS_DENIED',
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  UNSUPPORTED_FILE_TYPE: 'UNSUPPORTED_FILE_TYPE',
  UPLOAD_CAPACITY_EXCEEDED: 'UPLOAD_CAPACITY_EXCEEDED',
} as const;

export type FilesErrorCode = (typeof FilesErrorCode)[keyof typeof FilesErrorCode];

/**
 * 403 — the key lies outside the caller's `users/{id}/` prefix and the caller lacks `files:manage`.
 * The key is deliberately not echoed back in `details`.
 */
export class FileAccessDeniedException extends PermissionDeniedException {
  constructor(options?: DomainExceptionOptions) {
    super('You do not have access to this file', {
      ...options,
      code: FilesErrorCode.FILE_ACCESS_DENIED,
    });
  }
}

/** 404 — no object is stored under the (authorized) key. */
export class FileNotFoundException extends EntityNotFoundException {
  constructor(key: string, options?: DomainExceptionOptions) {
    super('File', key, { ...options, code: FilesErrorCode.FILE_NOT_FOUND });
  }
}

/**
 * 413 — the file is (or is announced to be) larger than `STORAGE_MAX_UPLOAD_BYTES`. Used for both
 * streamed uploads (the multipart stream overflowed; `field` = the multipart field) and presigned
 * uploads (the declared `contentLength` is too big), so clients handle one code. The limit also
 * travels as a validation issue, because problem+json / GraphQL extensions render `details.issues`
 * (as `errors`) but no other detail.
 */
export class FileTooLargeException extends DomainException {
  override readonly code: string = FilesErrorCode.FILE_TOO_LARGE;
  override readonly httpStatus: HttpStatus = HttpStatus.PAYLOAD_TOO_LARGE;

  constructor(
    readonly maxBytes: number,
    field: string,
    options?: DomainExceptionOptions,
  ) {
    const issue: ValidationIssue = {
      path: field,
      message: `must be at most ${maxBytes} bytes`,
      code: 'too_big',
    };
    super(`The file exceeds the maximum upload size of ${maxBytes} bytes`, {
      ...options,
      details: { ...options?.details, maxBytes, issues: [issue] },
    });
  }
}

/**
 * 415 — the content type is not in `ALLOWED_UPLOAD_CONTENT_TYPES`. The (client-supplied) type is
 * truncated before it is echoed back.
 */
export class UnsupportedFileTypeException extends DomainException {
  override readonly code: string = FilesErrorCode.UNSUPPORTED_FILE_TYPE;
  override readonly httpStatus: HttpStatus = HttpStatus.UNSUPPORTED_MEDIA_TYPE;
  readonly contentType: string;

  constructor(contentType: string, options?: DomainExceptionOptions) {
    const shown = truncate(contentType, { length: MAX_ECHOED_CONTENT_TYPE_LENGTH });
    super(`Files of type "${shown}" are not accepted`, {
      ...options,
      details: { ...options?.details, contentType: shown },
    });
    this.contentType = shown;
  }
}

/**
 * 503 — this process already streams `STORAGE_MAX_CONCURRENT_UPLOADS` files to storage. Load
 * shedding, not a fault: each streamed upload pins up to ~15 MiB of off-heap Buffers, so the cap
 * keeps a burst of uploads from OOM-killing the API container. Raised before a byte is read (the
 * multipart interceptor then discards the body); the HTTP edge adds `Retry-After: retryAfterSec`.
 * Clients should retry later or switch to a presigned upload. Like every 5xx it is logged at
 * `error` by the exception filter.
 */
export class UploadCapacityExceededException extends ServiceUnavailableException {
  constructor(
    readonly maxConcurrentUploads: number,
    readonly retryAfterSec: number,
    options?: DomainExceptionOptions,
  ) {
    super('Too many uploads in progress, retry later or use a presigned upload', {
      ...options,
      code: FilesErrorCode.UPLOAD_CAPACITY_EXCEEDED,
      details: { ...options?.details, maxConcurrentUploads, retryAfterSec },
    });
  }
}

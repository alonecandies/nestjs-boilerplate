import type { ValidationIssue } from '@app/common';
import { BadRequestException, ParseFilePipe } from '@nestjs/common';
import type { IncomingMultipartFile, MultipartOptions } from '@nestjs/platform-fastify/multipart';
import { isAllowedContentType } from '../../domain/file-content-type.js';
import { UnsupportedFileTypeException } from '../../domain/files.errors.js';
import { UPLOAD_FILE_FIELD } from '../../files.constants.js';

/**
 * Route-level options of the streaming upload. `limits.fileSize` is NOT here: it comes from
 * `STORAGE_MAX_UPLOAD_BYTES` through `MultipartModule.registerAsync` in `FilesModule`, and the
 * interceptor merges both `limits` objects key by key.
 *
 * - one file, no text fields (the file must be the only part — fields after it wouldn't even be
 *   parsed by a stream interceptor), short field names;
 * - the declared type is checked BEFORE a single byte is read: the request fails with 415 and
 *   the interceptor drains the body.
 */
export const FILE_UPLOAD_MULTIPART_OPTIONS = {
  limits: { files: 1, fields: 0, fieldNameSize: 100 },
  fileFilter(
    _req: unknown,
    file: IncomingMultipartFile,
    callback: (error: Error | null, acceptFile: boolean) => void,
  ): void {
    if (isAllowedContentType(file.mimetype)) callback(null, true);
    else callback(new UnsupportedFileTypeException(file.mimetype), false);
  },
} satisfies Omit<MultipartOptions, 'dest' | 'storage'>;

/**
 * `@UploadedFile()` pipe: a request without the `file` part (not multipart, empty file input…)
 * is a 400 with the same `errors[]` shape as every other validation failure.
 */
export const REQUIRED_UPLOAD_FILE_PIPE = new ParseFilePipe({
  fileIsRequired: true,
  exceptionFactory: (): BadRequestException => {
    const issue: ValidationIssue = {
      path: UPLOAD_FILE_FIELD,
      message: `a file is required in the "${UPLOAD_FILE_FIELD}" multipart field`,
      code: 'required',
    };
    return new BadRequestException({ message: 'Request validation failed', errors: [issue] });
  },
});

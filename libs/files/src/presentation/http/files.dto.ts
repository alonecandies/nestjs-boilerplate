import { MAX_STORAGE_KEY_BYTES } from '@app/storage';
import { z } from 'zod';
import { isValidFileKey } from '../../application/file-key.js';
import {
  ALLOWED_UPLOAD_CONTENT_TYPE_PATTERN,
  ALLOWED_UPLOAD_CONTENT_TYPES,
  MAX_FILENAME_LENGTH,
  MAX_PRESIGNED_UPLOAD_BYTES,
} from '../../files.constants.js';

/**
 * Body of `POST /v1/files/presigned-uploads` (Nest-native Standard Schema: `@Body({ schema })`).
 * `contentLength` is capped here by the absolute single-PUT limit; the configured
 * `STORAGE_MAX_UPLOAD_BYTES` is a runtime value, enforced by `FilesService` (413 FILE_TOO_LARGE).
 */
export const CreatePresignedUploadBodySchema = z
  .strictObject({
    filename: z
      .string()
      .trim()
      .min(1)
      .max(MAX_FILENAME_LENGTH)
      .describe('Original filename; sanitized into the object key')
      .meta({ example: 'Quarterly report.pdf' }),
    contentType: z
      .string()
      .trim()
      .toLowerCase()
      .regex(ALLOWED_UPLOAD_CONTENT_TYPE_PATTERN, {
        error: `must be one of: ${ALLOWED_UPLOAD_CONTENT_TYPES.join(', ')}`,
      })
      .describe('Media type the client will send as Content-Type (signed into the URL)')
      .meta({ example: 'application/pdf' }),
    contentLength: z
      .number()
      .int()
      .positive()
      .max(MAX_PRESIGNED_UPLOAD_BYTES)
      .describe('Exact size in bytes (signed; at most STORAGE_MAX_UPLOAD_BYTES)')
      .meta({ example: 482_133 }),
  })
  .meta({ id: 'CreatePresignedUploadRequest' });

export type CreatePresignedUploadBody = z.output<typeof CreatePresignedUploadBodySchema>;

/**
 * `?key=` of `GET /v1/files/download-url` and `DELETE /v1/files`. No `.meta({ id })`: Swagger only
 * expands query object schemas into parameters when they are not `$ref`s.
 */
export const FileKeyQuerySchema = z.strictObject({
  key: z
    .string()
    // `abort`: an empty/oversized key reports one issue, not also the (then pointless) refinement.
    .min(1, { abort: true })
    .max(MAX_STORAGE_KEY_BYTES, { abort: true })
    .refine(isValidFileKey, { error: 'is not a valid file key' })
    .describe('Object key returned by an upload (users/{userId}/{id}-{filename})'),
});

export type FileKeyQuery = z.output<typeof FileKeyQuerySchema>;

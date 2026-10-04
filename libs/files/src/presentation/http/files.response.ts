import { z } from 'zod';

/*
 * Response schemas: they document the responses (`@ApiOkResponse({ standardSchema })`) AND
 * serialize them (`@SerializeOptions({ schema })` + `StandardSchemaSerializerInterceptor`), which
 * strips anything a mapper might accidentally carry. Dates travel as ISO-8601 strings.
 */

export const UploadedFileResponseSchema = z
  .object({
    key: z.string().describe('Object key: pass it to download-url / delete'),
    filename: z.string().describe('Sanitized filename'),
    contentType: z.string(),
    size: z.number().int().nonnegative().optional().describe('Stored size in bytes'),
    etag: z.string().optional(),
  })
  .meta({ id: 'UploadedFile' });

export type UploadedFileResponse = z.output<typeof UploadedFileResponseSchema>;

export const PresignedUploadResponseSchema = z
  .object({
    key: z.string(),
    filename: z.string(),
    url: z.string().describe('PUT the file bytes here'),
    method: z.literal('PUT'),
    headers: z
      .record(z.string(), z.string())
      .describe('Send exactly these headers with the PUT (they are signed)'),
    expiresAt: z.iso.datetime(),
  })
  .meta({ id: 'PresignedUpload' });

export type PresignedUploadResponse = z.output<typeof PresignedUploadResponseSchema>;

export const DownloadUrlResponseSchema = z
  .object({
    key: z.string(),
    filename: z.string(),
    url: z.string().describe('GET downloads the file as an attachment'),
    expiresAt: z.iso.datetime(),
    size: z.number().int().nonnegative(),
    contentType: z.string().optional(),
  })
  .meta({ id: 'FileDownloadUrl' });

export type DownloadUrlResponse = z.output<typeof DownloadUrlResponseSchema>;

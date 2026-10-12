import type { ConfigType } from '@nestjs/config';
import { defineConfigNamespace, zInt } from '@platform/config';
import { z } from 'zod';

export const filesEnvSchema = z
  .object({
    STORAGE_MAX_UPLOAD_BYTES: zInt(26_214_400, { min: 1 }),
    STORAGE_MAX_CONCURRENT_UPLOADS: zInt(4, { min: 1 }),
  })
  .transform((env) => ({
    /** Per file: streamed uploads (multipart `limits.fileSize`) and presigned ones (`contentLength`). */
    maxUploadBytes: env.STORAGE_MAX_UPLOAD_BYTES,
    /** Streamed (API-proxied) uploads in flight per process; more get a 503 (memory bound). */
    maxConcurrentUploads: env.STORAGE_MAX_CONCURRENT_UPLOADS,
  }));

/**
 * Upload limits of the files context. The variables keep their `STORAGE_` names (no deployment
 * churn); the driver, bucket and presign settings stay in the platform `storage` namespace.
 */
export const filesConfig = defineConfigNamespace('files', filesEnvSchema);
export type FilesConfig = ConfigType<typeof filesConfig>;

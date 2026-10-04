import type { ConfigType } from '@nestjs/config';
import { z } from 'zod';
import { defineConfigNamespace } from '../define-config-namespace.js';
import { zBool, zEnum, zInt, zStr, zUrl } from '../env/env.helpers.js';

export const STORAGE_DRIVERS = ['s3', 'gcs'] as const;
export type StorageDriver = (typeof STORAGE_DRIVERS)[number];

/** S3 caps presigned URL lifetime at 7 days. */
const MAX_SIGNED_URL_TTL_SEC = 604_800;

export const storageEnvSchema = z
  .object({
    STORAGE_DRIVER: zEnum(STORAGE_DRIVERS, 's3'),
    STORAGE_MAX_UPLOAD_BYTES: zInt(26_214_400, { min: 1 }),
    STORAGE_SIGNED_URL_TTL_SEC: zInt(900, { min: 1, max: MAX_SIGNED_URL_TTL_SEC }),
    S3_ENDPOINT: zUrl('http://localhost:9000'),
    S3_PUBLIC_ENDPOINT: zUrl(),
    S3_REGION: zStr('us-east-1'),
    S3_FORCE_PATH_STYLE: zBool(true),
    S3_ACCESS_KEY_ID: zStr('rustfsadmin'),
    S3_SECRET_ACCESS_KEY: zStr('rustfsadmin'),
    S3_BUCKET: zStr('uploads'),
    GCS_PROJECT_ID: zStr('local-project'),
    GCS_BUCKET: zStr('uploads'),
    GCS_API_ENDPOINT: zUrl('http://localhost:4443'),
    GCS_KEY_FILE: zStr(),
  })
  .transform((env) => ({
    driver: env.STORAGE_DRIVER,
    maxUploadBytes: env.STORAGE_MAX_UPLOAD_BYTES,
    signedUrlTtlSec: env.STORAGE_SIGNED_URL_TTL_SEC,
    s3: {
      endpoint: env.S3_ENDPOINT,
      /** Host baked into presigned URLs (browsers can't reach the in-cluster endpoint). */
      publicEndpoint: env.S3_PUBLIC_ENDPOINT ?? env.S3_ENDPOINT,
      region: env.S3_REGION,
      /** Required by MinIO/RustFS-style endpoints without wildcard DNS. */
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      bucket: env.S3_BUCKET,
    },
    gcs: {
      projectId: env.GCS_PROJECT_ID,
      bucket: env.GCS_BUCKET,
      apiEndpoint: env.GCS_API_ENDPOINT,
      /** Service-account key file; unset → Application Default Credentials. */
      keyFilename: env.GCS_KEY_FILE,
    },
  }));

/** Object storage (S3-compatible or Google Cloud Storage), upload limits, presigned URL TTL. */
export const storageConfig = defineConfigNamespace('storage', storageEnvSchema);
export type StorageConfig = ConfigType<typeof storageConfig>;

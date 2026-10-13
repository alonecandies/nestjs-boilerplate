import type { ConfigType } from '@nestjs/config';
import { z } from 'zod';
import { defineConfigNamespace } from '../define-config-namespace.js';
import { zBool, zEnum, zInt, zNodeEnv, zStr, zUrl } from '../env/env.helpers.js';
import {
  addKnownLocalSecretIssue,
  isGoogleApisHost,
  isKnownLocalSecret,
  isPublicHttpsUrl,
  parseUrl,
} from '../env/production-guards.js';

export const STORAGE_DRIVERS = ['s3', 'gcs'] as const;
export type StorageDriver = (typeof STORAGE_DRIVERS)[number];

/** S3 caps presigned URL lifetime at 7 days. */
const MAX_SIGNED_URL_TTL_SEC = 604_800;

/** An https Google Cloud Storage endpoint (not an emulator such as fake-gcs-server). */
function isGoogleHttpsEndpoint(value: string): boolean {
  const url = parseUrl(value);
  return url?.protocol === 'https:' && isGoogleApisHost(url.hostname);
}

export const storageEnvSchema = z
  .object({
    NODE_ENV: zNodeEnv(),
    STORAGE_DRIVER: zEnum(STORAGE_DRIVERS, 's3'),
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
    // Host baked into GCS signed URLs, for an emulator browsers reach under another name.
    GCS_PUBLIC_ENDPOINT: zUrl(),
    GCS_KEY_FILE: zStr(),
    // LOCAL compose stack only: production refuses the emulator endpoints without it.
    STORAGE_ALLOW_INSECURE: zBool(false),
    // LOCAL compose stack only: accept the publicly known RustFS keys in production mode.
    ALLOW_KNOWN_LOCAL_SECRETS: zBool(false),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    if (env.STORAGE_DRIVER === 's3') {
      if (!env.STORAGE_ALLOW_INSECURE) {
        for (const key of ['S3_ENDPOINT', 'S3_PUBLIC_ENDPOINT'] as const) {
          const value = env[key];
          if (value !== undefined && !isPublicHttpsUrl(value)) {
            ctx.addIssue({
              code: 'custom',
              path: [key],
              message: `${key} must be an https, non-loopback endpoint in production (the default is the local RustFS), or set STORAGE_ALLOW_INSECURE=true for the local compose stack only`,
            });
          }
        }
      }
      if (!env.ALLOW_KNOWN_LOCAL_SECRETS) {
        for (const key of ['S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const) {
          if (isKnownLocalSecret(env[key])) addKnownLocalSecretIssue(ctx, key);
        }
      }
    } else if (!env.STORAGE_ALLOW_INSECURE) {
      if (!isGoogleHttpsEndpoint(env.GCS_API_ENDPOINT)) {
        ctx.addIssue({
          code: 'custom',
          path: ['GCS_API_ENDPOINT'],
          message:
            'GCS_API_ENDPOINT must be a Google endpoint (https://storage.googleapis.com) in production (the default is the local fake-gcs emulator), or set STORAGE_ALLOW_INSECURE=true for the local compose stack only',
        });
      }
      // Only Google serves a URL signed for GCS: a CDN or any other host would break every link.
      if (
        env.GCS_PUBLIC_ENDPOINT !== undefined &&
        !isGoogleHttpsEndpoint(env.GCS_PUBLIC_ENDPOINT)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['GCS_PUBLIC_ENDPOINT'],
          message:
            'GCS_PUBLIC_ENDPOINT must be an https Google endpoint in production (only Google serves URLs signed for GCS; the setting exists for emulators), or set STORAGE_ALLOW_INSECURE=true for the local compose stack only',
        });
      }
    }
  })
  .transform((env) => ({
    driver: env.STORAGE_DRIVER,
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
      /** Host of signed URLs (the SDK `host` option, path-style); unset = the API endpoint. */
      publicEndpoint: env.GCS_PUBLIC_ENDPOINT,
      /** Service-account key file; unset → Application Default Credentials. */
      keyFilename: env.GCS_KEY_FILE,
    },
  }));

/**
 * Object storage (S3-compatible or Google Cloud Storage) and presigned URL TTL. Upload limits are
 * not part of it: the domain that accepts uploads defines them in its own namespace.
 */
export const storageConfig = defineConfigNamespace('storage', storageEnvSchema);
export type StorageConfig = ConfigType<typeof storageConfig>;

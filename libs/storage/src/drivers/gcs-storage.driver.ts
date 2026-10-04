import { generateKeyPairSync } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import type { StorageConfig } from '@app/config';
import {
  ApiError,
  type Bucket,
  type CreateWriteStreamOptions,
  type FileMetadata,
  Storage,
  type StorageOptions,
} from '@google-cloud/storage';
import { endsWith, isNil, mapValues, omitBy } from 'lodash-es';
import { toStorageException } from '../storage.errors.js';
import { StorageService } from '../storage.service.js';
import type {
  ObjectHead,
  PresignDownloadOptions,
  PresignedDownload,
  PresignedUpload,
  PresignUploadOptions,
  StoredObject,
  UploadInput,
} from '../storage.types.js';
import {
  assertStorageKey,
  attachmentContentDisposition,
  resolveSignedUrlTtlSec,
  unquoteEtag,
} from '../storage-key.util.js';

type GcsSettings = StorageConfig['gcs'];

/** Real Google endpoints (vs. an emulator such as fake-gcs-server). */
export function isGoogleStorageEndpoint(apiEndpoint: string): boolean {
  try {
    return endsWith(new URL(apiEndpoint).hostname, 'googleapis.com');
  } catch {
    return false;
  }
}

/**
 * Emulator-only signing identity: v4 signed URLs are signed locally with an RSA key, and
 * fake-gcs-server doesn't verify signatures — without ANY key, `getSignedUrl` throws
 * "Cannot sign data without `client_email`".
 */
function ephemeralCredentials(projectId: string): { client_email: string; private_key: string } {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return { client_email: `emulator@${projectId}.iam.gserviceaccount.com`, private_key: privateKey };
}

/**
 * Builds the GCS client. For the real service the API endpoint is left to the SDK (a custom
 * `apiEndpoint` disables authentication unless `useAuthWithCustomEndpoint`); credentials come from
 * `GCS_KEY_FILE` or Application Default Credentials (Workload Identity — needs
 * `iam.serviceAccounts.signBlob` for signed URLs).
 */
export function createGcsClient(gcs: GcsSettings): Storage {
  const emulator = !isGoogleStorageEndpoint(gcs.apiEndpoint);
  const options: StorageOptions = {
    projectId: gcs.projectId,
    retryOptions: { autoRetry: true, maxRetries: 3 },
  };
  if (gcs.keyFilename !== undefined) options.keyFilename = gcs.keyFilename;
  if (emulator) {
    options.apiEndpoint = gcs.apiEndpoint;
    if (gcs.keyFilename === undefined) options.credentials = ephemeralCredentials(gcs.projectId);
  }
  return new Storage(options);
}

const isGcsSdkError = (error: unknown): boolean => error instanceof ApiError;
const isNotFound = (error: unknown): boolean => error instanceof ApiError && error.code === 404;

function toSize(size: FileMetadata['size']): number | undefined {
  if (isNil(size)) return undefined;
  const n = Number(size);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Google Cloud Storage driver. Uploads are single-request (`resumable: false`: no session
 * round-trip; right for API-sized files) and streamed with `stream/promises.pipeline`, which
 * destroys both sides on error. Signed URLs are v4.
 */
export class GcsStorageDriver extends StorageService {
  override readonly driver = 'gcs';
  private readonly bucket: Bucket;
  private readonly defaultTtlSec: number;

  constructor(cfg: StorageConfig, storage: Storage = createGcsClient(cfg.gcs)) {
    super();
    this.bucket = storage.bucket(cfg.gcs.bucket);
    this.defaultTtlSec = cfg.signedUrlTtlSec;
  }

  override async upload(input: UploadInput): Promise<StoredObject> {
    const file = this.bucket.file(assertStorageKey(input.key));
    const options: CreateWriteStreamOptions = {
      resumable: false,
      contentType: input.contentType,
      validation: 'crc32c',
      metadata: omitBy(
        {
          contentType: input.contentType,
          cacheControl: input.cacheControl,
          metadata: input.metadata,
        },
        isNil,
      ),
    };
    try {
      if (Buffer.isBuffer(input.body)) await file.save(input.body, options);
      else await pipeline(input.body, file.createWriteStream(options));
    } catch (error) {
      throw toStorageException(error, 'upload', isGcsSdkError);
    }
    const metadata = file.metadata;
    return {
      key: file.name,
      size:
        toSize(metadata.size) ??
        input.contentLength ??
        (Buffer.isBuffer(input.body) ? input.body.length : undefined),
      contentType: input.contentType,
      etag: unquoteEtag(metadata.etag),
    };
  }

  /**
   * v4 signed PUT. `Content-Type` is signed; with `contentLength` the signed
   * `x-goog-content-length-range: 0,<n>` header makes GCS reject bodies larger than announced.
   */
  override async createPresignedUpload(
    key: string,
    opts: PresignUploadOptions,
  ): Promise<PresignedUpload> {
    const file = this.bucket.file(assertStorageKey(key));
    const ttl = resolveSignedUrlTtlSec(opts.expiresInSec, this.defaultTtlSec);
    const expiresAt = new Date(Date.now() + ttl * 1000);
    const extensionHeaders: Record<string, string> =
      opts.contentLength === undefined
        ? {}
        : { 'x-goog-content-length-range': `0,${opts.contentLength}` };
    try {
      const [url] = await file.getSignedUrl({
        version: 'v4',
        action: 'write',
        expires: expiresAt,
        contentType: opts.contentType,
        extensionHeaders,
      });
      return {
        key,
        url,
        method: 'PUT',
        headers: { 'content-type': opts.contentType, ...extensionHeaders },
        expiresAt,
      };
    } catch (error) {
      throw toStorageException(error, 'presign-upload', isGcsSdkError);
    }
  }

  override async createPresignedDownload(
    key: string,
    opts: PresignDownloadOptions = {},
  ): Promise<PresignedDownload> {
    const file = this.bucket.file(assertStorageKey(key));
    const ttl = resolveSignedUrlTtlSec(opts.expiresInSec, this.defaultTtlSec);
    const expiresAt = new Date(Date.now() + ttl * 1000);
    try {
      const [url] = await file.getSignedUrl({
        version: 'v4',
        action: 'read',
        expires: expiresAt,
        ...(opts.filename === undefined
          ? {}
          : { responseDisposition: attachmentContentDisposition(opts.filename) }),
      });
      return { url, expiresAt };
    } catch (error) {
      throw toStorageException(error, 'presign-download', isGcsSdkError);
    }
  }

  override async head(key: string): Promise<ObjectHead | null> {
    const file = this.bucket.file(assertStorageKey(key));
    try {
      const [metadata] = await file.getMetadata();
      return {
        key,
        size: toSize(metadata.size) ?? 0,
        contentType: metadata.contentType,
        lastModified: metadata.updated === undefined ? undefined : new Date(metadata.updated),
        etag: unquoteEtag(metadata.etag),
        // GCS custom metadata values may be non-strings/null; normalize to the S3-like string map.
        metadata: mapValues(omitBy(metadata.metadata ?? {}, isNil), String),
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw toStorageException(error, 'head', isGcsSdkError);
    }
  }

  override async delete(key: string): Promise<void> {
    try {
      await this.bucket.file(assertStorageKey(key)).delete({ ignoreNotFound: true });
    } catch (error) {
      throw toStorageException(error, 'delete', isGcsSdkError);
    }
  }
}

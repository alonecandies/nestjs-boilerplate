import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import {
  ApiError,
  type Bucket,
  type CreateWriteStreamOptions,
  type FileMetadata,
  Storage,
  type StorageOptions,
} from '@google-cloud/storage';
import type { StorageConfig } from '@platform/config';
import { endsWith, isNil, isPlainObject, isString, mapValues, omitBy } from 'lodash-es';
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
type ServiceAccountKey = { client_email: string; private_key: string };

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
function ephemeralCredentials(projectId: string): ServiceAccountKey {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return { client_email: `emulator@${projectId}.iam.gserviceaccount.com`, private_key: privateKey };
}

/**
 * Reads `GCS_KEY_FILE` and accepts ONLY a service-account key. The SDK's `keyFilename` option
 * (deprecated in @google-cloud/storage 8.4) loads whatever credential type the file declares
 * (external_account, impersonated, …): a credential-injection risk when the file is not fully
 * under your control. Fails at boot with a message that names the variable. Use Application
 * Default Credentials (leave GCS_KEY_FILE unset) for Workload Identity or federation.
 */
function readServiceAccountKey(path: string): ServiceAccountKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`GCS_KEY_FILE ${path} could not be read as JSON: ${String(error)}`);
  }
  // Every field is checked below, so an object of unknown values is all this needs to assume.
  const key = (isPlainObject(parsed) ? parsed : {}) as Partial<
    Record<keyof ServiceAccountKey | 'type', unknown>
  >;
  if (key.type !== 'service_account' || !isString(key.client_email) || !isString(key.private_key)) {
    throw new Error(
      `GCS_KEY_FILE ${path} must be a service_account key with client_email and private_key`,
    );
  }
  return { client_email: key.client_email, private_key: key.private_key };
}

/**
 * Builds the GCS client. For the real service the API endpoint is left to the SDK (a custom
 * `apiEndpoint` disables authentication unless `useAuthWithCustomEndpoint`); credentials come from
 * a validated `GCS_KEY_FILE` service-account key, or from Application Default Credentials
 * (Workload Identity — needs `iam.serviceAccounts.signBlob` for signed URLs).
 */
export function createGcsClient(gcs: GcsSettings): Storage {
  const emulator = !isGoogleStorageEndpoint(gcs.apiEndpoint);
  const options: StorageOptions = {
    projectId: gcs.projectId,
    retryOptions: { autoRetry: true, maxRetries: 3 },
  };
  if (emulator) options.apiEndpoint = gcs.apiEndpoint;
  const key =
    gcs.keyFilename !== undefined
      ? readServiceAccountKey(gcs.keyFilename)
      : emulator
        ? ephemeralCredentials(gcs.projectId)
        : undefined;
  if (key !== undefined) {
    // The SDK signs v4 URLs only with credentials it was given (it never derives them from an
    // `authClient`, and `fromJSON` is deprecated too). The deprecation targets UNVALIDATED configs;
    // this key is a checked service-account key, which is the mitigation Google documents.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    options.credentials = key;
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
  /** `host` of signed URLs: browsers reach an emulator under another name than the API does. */
  private readonly signing: { host?: string };

  constructor(cfg: StorageConfig, storage: Storage = createGcsClient(cfg.gcs)) {
    super();
    this.bucket = storage.bucket(cfg.gcs.bucket);
    this.defaultTtlSec = cfg.signedUrlTtlSec;
    // `host` (unlike `cname`) keeps the path-style `/<bucket>/<object>` the emulator serves.
    this.signing = cfg.gcs.publicEndpoint === undefined ? {} : { host: cfg.gcs.publicEndpoint };
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
        ...this.signing,
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
        ...this.signing,
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

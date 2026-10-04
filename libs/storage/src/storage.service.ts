import type {
  ObjectHead,
  PresignDownloadOptions,
  PresignedDownload,
  PresignedUpload,
  PresignUploadOptions,
  StorageDriverName,
  StoredObject,
  UploadInput,
} from './storage.types.js';

/**
 * Driver-agnostic object storage port. Consumers inject `StorageService`; `StorageModule` binds
 * the S3 or GCS driver selected by `STORAGE_DRIVER` (abstract class → usable as DI token).
 *
 * Prefer presigned URLs for browser uploads/downloads: bytes then never transit the API process.
 * `upload()` streams for server-side ingestion: memory per upload is bounded (driver chunking, see
 * `S3_UPLOAD_PART_SIZE`) but not zero, so callers should cap how many run at once.
 */
export abstract class StorageService {
  abstract readonly driver: StorageDriverName;

  /** Streams `body` to `key` (overwrites). */
  abstract upload(input: UploadInput): Promise<StoredObject>;

  /** Time-limited URL a client can `PUT` the object to directly. */
  abstract createPresignedUpload(key: string, opts: PresignUploadOptions): Promise<PresignedUpload>;

  /** Time-limited `GET` URL (optionally forcing a download filename). */
  abstract createPresignedDownload(
    key: string,
    opts?: PresignDownloadOptions,
  ): Promise<PresignedDownload>;

  /** Object metadata, or `null` when the key does not exist. */
  abstract head(key: string): Promise<ObjectHead | null>;

  /** Idempotent: deleting a missing key succeeds. */
  abstract delete(key: string): Promise<void>;
}

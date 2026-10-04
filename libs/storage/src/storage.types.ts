import type { Readable } from 'node:stream';
import type { StorageDriver } from '@app/config';

/** Concrete backend behind `StorageService` (`memory` = `InMemoryStorageService`, tests only). */
export type StorageDriverName = StorageDriver | 'memory';

export interface UploadInput {
  key: string;
  /** A stream is uploaded without buffering the whole object (multipart for large bodies). */
  body: Readable | Buffer;
  contentType: string;
  /** Known size in bytes (skips length detection; must be exact when set). */
  contentLength?: number;
  /** User metadata (`x-amz-meta-*` / GCS custom metadata). US-ASCII values only. */
  metadata?: Record<string, string>;
  cacheControl?: string;
}

export interface StoredObject {
  key: string;
  size?: number;
  contentType: string;
  /** Unquoted entity tag. */
  etag?: string;
}

export interface PresignUploadOptions {
  /** Signed: the client MUST send exactly this `Content-Type`. */
  contentType: string;
  /** Signed when set: caps (GCS) / pins (S3) the uploaded size. */
  contentLength?: number;
  /** Defaults to `STORAGE_SIGNED_URL_TTL_SEC`; clamped to [1s, 7d]. */
  expiresInSec?: number;
}

export interface PresignedUpload {
  key: string;
  url: string;
  method: 'PUT';
  /** Headers the client must send with the upload for the signature to match. */
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface PresignDownloadOptions {
  expiresInSec?: number;
  /** Forces `Content-Disposition: attachment` with this (sanitized) filename. */
  filename?: string;
}

export interface PresignedDownload {
  url: string;
  expiresAt: Date;
}

export interface ObjectHead {
  key: string;
  size: number;
  contentType?: string;
  lastModified?: Date;
  etag?: string;
  metadata: Record<string, string>;
}

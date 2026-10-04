import type { Readable } from 'node:stream';
import type { AuthUser } from '@app/auth';

/** Who acts on a file: the authenticated user (only what the policies need). */
export type FileActor = Pick<AuthUser, 'id' | 'permissions'>;

export interface UploadFileParams {
  /** Client-supplied name; sanitized into the key. */
  filename: string;
  /** Declared media type (checked against the allow-list). */
  contentType: string;
  /**
   * The file bytes, streamed to storage (never as one whole-file buffer; the driver holds bounded
   * chunks). The caller bounds it: the HTTP edge sets `limits.fileSize = STORAGE_MAX_UPLOAD_BYTES`
   * on the multipart parser.
   */
  body: Readable;
}

export interface UploadedFile {
  key: string;
  filename: string;
  contentType: string;
  size?: number | undefined;
  etag?: string | undefined;
}

export interface UploadUrlParams {
  filename: string;
  contentType: string;
  /** Exact size in bytes; signed into the URL so the client cannot upload more. */
  contentLength: number;
}

export interface FileUploadUrl {
  key: string;
  filename: string;
  url: string;
  method: 'PUT';
  /** Headers the client must send with the PUT for the signature to match. */
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface FileDownloadUrl {
  key: string;
  filename: string;
  url: string;
  expiresAt: Date;
  size: number;
  contentType?: string | undefined;
}

/** How the actor may reach a key: as its owner, through `files:manage`, or not at all. */
export type FileAccess = 'owner' | 'manager' | 'denied';

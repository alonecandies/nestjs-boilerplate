import { DomainValidationException } from '@app/common';
import { type StorageConfig, storageConfig } from '@app/config';
import { StorageService } from '@app/storage';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { assertAllowedContentType } from '../domain/file-content-type.js';
import {
  FileAccessDeniedException,
  FileNotFoundException,
  FileTooLargeException,
} from '../domain/files.errors.js';
import { resolveFileAccess } from './file-access.policy.js';
import { buildUserFileKey, filenameOfFileKey } from './file-key.js';
import type {
  FileActor,
  FileDownloadUrl,
  FileUploadUrl,
  UploadedFile,
  UploadFileParams,
  UploadUrlParams,
} from './files.types.js';

/** User metadata stored with every object (`x-amz-meta-uploaded-by` / GCS custom metadata). */
export const UPLOADED_BY_METADATA_KEY = 'uploaded-by';

/**
 * Use cases of the files context (edge-only: no service/topology split, so there is no port pair
 * here — the hexagonal seam is the `StorageService` port, bound to S3, GCS or memory).
 *
 * Every key operation goes through `resolveFileAccess` (validated key → owner prefix or
 * `files:manage`). Uploads always get a fresh key; nothing can be overwritten.
 */
@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);

  constructor(
    private readonly storage: StorageService,
    @Inject(storageConfig.KEY) private readonly config: StorageConfig,
  ) {}

  /** `STORAGE_MAX_UPLOAD_BYTES` — what the edge must bound streamed uploads to. */
  get maxUploadBytes(): number {
    return this.config.maxUploadBytes;
  }

  /** Streams `params.body` to `users/{actor}/{uuidv7}-{safeFilename}` without buffering it. */
  async upload(actor: FileActor, params: UploadFileParams): Promise<UploadedFile> {
    const contentType = assertAllowedContentType(params.contentType);
    const key = buildUserFileKey(actor.id, params.filename);
    const stored = await this.storage.upload({
      key,
      body: params.body,
      contentType,
      metadata: { [UPLOADED_BY_METADATA_KEY]: actor.id },
    });
    this.logger.debug(`Stored ${stored.key} (${stored.size ?? '?'} bytes)`);
    return {
      key: stored.key,
      filename: filenameOfFileKey(stored.key),
      contentType: stored.contentType,
      size: stored.size,
      etag: stored.etag,
    };
  }

  /**
   * Presigned `PUT` for a direct browser → bucket upload (the bytes never touch the API). The
   * signature pins the content type and the exact length, so the limit checked here holds.
   */
  async createUploadUrl(actor: FileActor, params: UploadUrlParams): Promise<FileUploadUrl> {
    const contentType = assertAllowedContentType(params.contentType);
    this.assertUploadSize(params.contentLength);
    const key = buildUserFileKey(actor.id, params.filename);
    const presigned = await this.storage.createPresignedUpload(key, {
      contentType,
      contentLength: params.contentLength,
    });
    return {
      key: presigned.key,
      filename: filenameOfFileKey(presigned.key),
      url: presigned.url,
      method: presigned.method,
      headers: presigned.headers,
      expiresAt: presigned.expiresAt,
    };
  }

  /**
   * Presigned `GET` that always downloads as an attachment (never rendered inline by the
   * browser). Access is checked before existence, so other users' keys cannot be probed.
   */
  async createDownloadUrl(actor: FileActor, key: string): Promise<FileDownloadUrl> {
    this.authorize(actor, key, 'download');
    const head = await this.storage.head(key);
    if (head === null) throw new FileNotFoundException(key);
    const filename = filenameOfFileKey(key);
    const download = await this.storage.createPresignedDownload(key, { filename });
    return {
      key,
      filename,
      url: download.url,
      expiresAt: download.expiresAt,
      size: head.size,
      contentType: head.contentType,
    };
  }

  /** Idempotent: deleting a missing (but authorized) key succeeds. */
  async deleteFile(actor: FileActor, key: string): Promise<void> {
    this.authorize(actor, key, 'delete');
    await this.storage.delete(key);
  }

  private authorize(actor: FileActor, key: string, action: 'download' | 'delete'): void {
    const access = resolveFileAccess(actor, key);
    if (access === 'denied') throw new FileAccessDeniedException();
    // Audit trail for the admin bypass (owners acting on their own files are not worth a line).
    if (access === 'manager') this.logger.log(`files:manage ${action} of ${key} by ${actor.id}`);
  }

  private assertUploadSize(contentLength: number): void {
    if (!Number.isSafeInteger(contentLength) || contentLength < 1) {
      throw new DomainValidationException('Invalid content length', {
        issues: [{ path: 'contentLength', message: 'must be a positive integer' }],
      });
    }
    if (contentLength > this.config.maxUploadBytes) {
      throw new FileTooLargeException(this.config.maxUploadBytes, 'contentLength');
    }
  }
}

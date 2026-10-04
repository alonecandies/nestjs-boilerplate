import { createHash } from 'node:crypto';
import { buffer as readAll } from 'node:stream/consumers';
import { sortBy, startsWith } from 'lodash-es';
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
} from '../storage-key.util.js';

/** An object held by `InMemoryStorageService`. */
export interface InMemoryObject {
  body: Buffer;
  contentType: string;
  metadata: Record<string, string>;
  cacheControl?: string;
  etag: string;
  lastModified: Date;
}

export interface InMemoryStorageOptions {
  /** Default presigned URL lifetime (mirrors `STORAGE_SIGNED_URL_TTL_SEC`). Default 900. */
  signedUrlTtlSec?: number;
  /** Base of the fake presigned URLs. Default `memory://storage`. */
  baseUrl?: string;
}

/**
 * `StorageService` held in process memory, for unit/e2e tests and zero-infra local demos.
 * It follows the real drivers' contract (key validation, idempotent delete, `null` head for a
 * missing key, TTL clamping, a stream body read to its end). Presigned URLs are fake
 * `memory://` URLs that carry the same query parameters tests usually assert on.
 * Not for production: it has no size limits, and the data is gone when the process exits.
 */
export class InMemoryStorageService extends StorageService {
  override readonly driver = 'memory';
  private readonly objects = new Map<string, InMemoryObject>();
  private readonly defaultTtlSec: number;
  private readonly baseUrl: string;

  constructor(options: InMemoryStorageOptions = {}) {
    super();
    this.defaultTtlSec = options.signedUrlTtlSec ?? 900;
    this.baseUrl = options.baseUrl ?? 'memory://storage';
  }

  override async upload(input: UploadInput): Promise<StoredObject> {
    const key = assertStorageKey(input.key);
    const body = Buffer.isBuffer(input.body) ? input.body : await readAll(input.body);
    const etag = createHash('md5').update(body).digest('hex');
    this.objects.set(key, {
      body,
      contentType: input.contentType,
      metadata: { ...input.metadata },
      ...(input.cacheControl === undefined ? {} : { cacheControl: input.cacheControl }),
      etag,
      lastModified: new Date(),
    });
    return { key, size: body.length, contentType: input.contentType, etag };
  }

  override async createPresignedUpload(
    key: string,
    opts: PresignUploadOptions,
  ): Promise<PresignedUpload> {
    assertStorageKey(key);
    const ttl = resolveSignedUrlTtlSec(opts.expiresInSec, this.defaultTtlSec);
    const url = this.buildUrl(key, 'PUT', ttl, { 'content-type': opts.contentType });
    return {
      key,
      url,
      method: 'PUT',
      headers: { 'content-type': opts.contentType },
      expiresAt: new Date(Date.now() + ttl * 1000),
    };
  }

  override async createPresignedDownload(
    key: string,
    opts: PresignDownloadOptions = {},
  ): Promise<PresignedDownload> {
    assertStorageKey(key);
    const ttl = resolveSignedUrlTtlSec(opts.expiresInSec, this.defaultTtlSec);
    const extra: Record<string, string> =
      opts.filename === undefined
        ? {}
        : { 'response-content-disposition': attachmentContentDisposition(opts.filename) };
    return {
      url: this.buildUrl(key, 'GET', ttl, extra),
      expiresAt: new Date(Date.now() + ttl * 1000),
    };
  }

  override async head(key: string): Promise<ObjectHead | null> {
    const object = this.objects.get(assertStorageKey(key));
    if (object === undefined) return null;
    return {
      key,
      size: object.body.length,
      contentType: object.contentType,
      lastModified: object.lastModified,
      etag: object.etag,
      metadata: { ...object.metadata },
    };
  }

  override async delete(key: string): Promise<void> {
    this.objects.delete(assertStorageKey(key));
  }

  /** Test helper: the stored object (body + metadata), or `undefined` if absent. */
  getObject(key: string): InMemoryObject | undefined {
    return this.objects.get(key);
  }

  /** Test helper: all stored keys, sorted, optionally only those under `prefix`. */
  listKeys(prefix = ''): string[] {
    return sortBy([...this.objects.keys()].filter((k) => startsWith(k, prefix)));
  }

  /** Test helper: drop everything (call in `afterEach`). */
  clear(): void {
    this.objects.clear();
  }

  private buildUrl(
    key: string,
    method: string,
    ttl: number,
    extra: Record<string, string>,
  ): string {
    const url = new URL(`${this.baseUrl}/${key.split('/').map(encodeURIComponent).join('/')}`);
    url.searchParams.set('method', method);
    url.searchParams.set('expires', String(ttl));
    for (const [name, value] of Object.entries(extra)) url.searchParams.set(name, value);
    return url.toString();
  }
}

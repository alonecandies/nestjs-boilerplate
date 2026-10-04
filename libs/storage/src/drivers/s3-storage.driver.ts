import type { StorageConfig } from '@app/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { OnModuleDestroy } from '@nestjs/common';
import { isObject } from 'lodash-es';
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

/** lib-storage multipart tuning: memory per upload ≈ queueSize × partSize (4 × 8 MiB). */
export const S3_UPLOAD_PART_SIZE = 8 * 1024 * 1024;
export const S3_UPLOAD_QUEUE_SIZE = 4;

/** `content-type` is unsignable by default in the S3 presigner — force it into the signature. */
const SIGNED_UPLOAD_HEADERS = new Set(['content-type']);

type S3Settings = StorageConfig['s3'];

/**
 * One client per endpoint. `WHEN_REQUIRED` checksums: SDK ≥ 3.729 adds CRC32 checksums by default,
 * which many S3-compatibles reject and which break presigned PUTs (the URL would carry the checksum
 * of an EMPTY body). The SDK builds keep-alive agents from the plain handler options; `maxSockets`
 * is raised from its default of 50 for concurrent multipart uploads.
 */
export function createS3Client(s3: S3Settings, endpoint: string = s3.endpoint): S3Client {
  return new S3Client({
    region: s3.region,
    endpoint,
    forcePathStyle: s3.forcePathStyle,
    credentials: { accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    maxAttempts: 3,
    requestHandler: {
      connectionTimeout: 3_000,
      requestTimeout: 30_000,
      httpAgent: { keepAlive: true, maxSockets: 256 },
      httpsAgent: { keepAlive: true, maxSockets: 256 },
    },
  });
}

const isS3SdkError = (error: unknown): boolean =>
  error instanceof S3ServiceException || (isObject(error) && '$metadata' in error);

const isNotFound = (error: unknown): boolean =>
  error instanceof S3ServiceException &&
  (error.name === 'NotFound' ||
    error.name === 'NoSuchKey' ||
    error.$metadata.httpStatusCode === 404);

/** Pre-built SDK clients (tests, custom middleware stacks). Defaults are built from the config. */
export interface S3StorageClients {
  /** Talks to `S3_ENDPOINT` (uploads, HEAD, DELETE). */
  client?: S3Client;
  /** Signs presigned URLs for `S3_PUBLIC_ENDPOINT`; defaults to `client` when both endpoints match. */
  presignClient?: S3Client;
}

/**
 * S3 / S3-compatible (RustFS, MinIO, R2, …) driver. Presigned URLs are signed by a second client
 * bound to `S3_PUBLIC_ENDPOINT`: the host is part of the SigV4 signature, and browsers can't reach
 * the in-cluster endpoint (`http://rustfs:9000`). Presigning is local — no network round trip.
 */
export class S3StorageDriver extends StorageService implements OnModuleDestroy {
  override readonly driver = 's3';
  private readonly client: S3Client;
  private readonly presignClient: S3Client;
  private readonly bucket: string;
  private readonly defaultTtlSec: number;

  constructor(cfg: StorageConfig, clients: S3StorageClients = {}) {
    super();
    this.bucket = cfg.s3.bucket;
    this.defaultTtlSec = cfg.signedUrlTtlSec;
    this.client = clients.client ?? createS3Client(cfg.s3);
    this.presignClient =
      clients.presignClient ??
      (cfg.s3.publicEndpoint === cfg.s3.endpoint
        ? this.client
        : createS3Client(cfg.s3, cfg.s3.publicEndpoint));
  }

  /**
   * lib-storage `Upload`: bodies up to one part are a single PutObject, larger/unknown-length
   * streams become a concurrent multipart upload (a plain PutObject of a stream without
   * ContentLength fails). Failed multipart uploads are aborted (`leavePartsOnError: false`).
   */
  override async upload(input: UploadInput): Promise<StoredObject> {
    const key = assertStorageKey(input.key);
    let uploadedBytes = 0;
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: key,
        Body: input.body,
        ContentType: input.contentType,
        ContentLength: input.contentLength,
        Metadata: input.metadata,
        CacheControl: input.cacheControl,
      },
      queueSize: S3_UPLOAD_QUEUE_SIZE,
      partSize: S3_UPLOAD_PART_SIZE,
      leavePartsOnError: false,
    });
    upload.on('httpUploadProgress', ({ loaded }) => {
      if (loaded !== undefined && loaded > uploadedBytes) uploadedBytes = loaded;
    });

    try {
      const result = await upload.done();
      const size =
        input.contentLength ?? (Buffer.isBuffer(input.body) ? input.body.length : uploadedBytes);
      return { key, size, contentType: input.contentType, etag: unquoteEtag(result.ETag) };
    } catch (error) {
      throw toStorageException(error, 'upload', isS3SdkError);
    }
  }

  /**
   * Signed headers: `host`, `content-type` and — when `contentLength` is given — `content-length`,
   * so the client can neither change the type nor upload more/less than announced.
   */
  override async createPresignedUpload(
    key: string,
    opts: PresignUploadOptions,
  ): Promise<PresignedUpload> {
    assertStorageKey(key);
    const ttl = resolveSignedUrlTtlSec(opts.expiresInSec, this.defaultTtlSec);
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: opts.contentType,
      ContentLength: opts.contentLength,
    });
    const url = await getSignedUrl(this.presignClient, command, {
      expiresIn: ttl,
      signableHeaders: SIGNED_UPLOAD_HEADERS,
    });
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
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ResponseContentDisposition:
        opts.filename === undefined ? undefined : attachmentContentDisposition(opts.filename),
    });
    const url = await getSignedUrl(this.presignClient, command, { expiresIn: ttl });
    return { url, expiresAt: new Date(Date.now() + ttl * 1000) };
  }

  override async head(key: string): Promise<ObjectHead | null> {
    assertStorageKey(key);
    try {
      const out = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return {
        key,
        size: out.ContentLength ?? 0,
        contentType: out.ContentType,
        lastModified: out.LastModified,
        etag: unquoteEtag(out.ETag),
        metadata: out.Metadata ?? {},
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw toStorageException(error, 'head', isS3SdkError);
    }
  }

  override async delete(key: string): Promise<void> {
    assertStorageKey(key);
    try {
      // S3 DELETE is idempotent (204 for a missing key).
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (error) {
      throw toStorageException(error, 'delete', isS3SdkError);
    }
  }

  /** Releases the keep-alive sockets so shutdown isn't delayed by idle connections. */
  onModuleDestroy(): void {
    this.client.destroy();
    if (this.presignClient !== this.client) this.presignClient.destroy();
  }
}

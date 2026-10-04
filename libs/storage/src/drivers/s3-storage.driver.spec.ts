import { Readable } from 'node:stream';
import { buffer as readAll } from 'node:stream/consumers';
import { DomainValidationException, ExternalServiceException } from '@app/common';
import { storageConfig } from '@app/config';
import { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import { S3_UPLOAD_PART_SIZE, S3StorageDriver } from './s3-storage.driver.js';

const cfg = storageConfig.parse({
  STORAGE_DRIVER: 's3',
  S3_ENDPOINT: 'http://rustfs:9000',
  S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'uploads',
  S3_ACCESS_KEY_ID: 'test-access',
  S3_SECRET_ACCESS_KEY: 'test-secret',
});

/** What the fake handler sees of an SDK request (subset of smithy's HttpRequest). */
interface SdkRequest {
  method: string;
  path: string;
  query: Record<string, string | string[] | null>;
  headers: Record<string, string>;
  body?: unknown;
}

interface Recorded {
  method: string;
  path: string;
  query: Record<string, string | string[] | null>;
  headers: Record<string, string>;
  body: Buffer;
}

interface FakeResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
}

async function bodyBytes(body: unknown): Promise<Buffer> {
  if (body === undefined || body === null) return Buffer.alloc(0);
  if (typeof body === 'string') return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  return readAll(body as Readable);
}

/**
 * A real `S3Client` whose transport is replaced by `reply`: the SDK's serializers, lib-storage's
 * multipart logic and SigV4 signing all run for real — only the socket is faked.
 */
function fakeS3(
  reply: (req: Recorded) => FakeResponse = () => ({}),
  endpoint: string = cfg.s3.endpoint,
): {
  client: S3Client;
  requests: Recorded[];
} {
  const requests: Recorded[] = [];
  const requestHandler = {
    handle: async (request: SdkRequest) => {
      const recorded: Recorded = {
        method: request.method,
        path: request.path,
        query: request.query,
        headers: request.headers,
        body: await bodyBytes(request.body),
      };
      requests.push(recorded);
      const res = reply(recorded);
      return {
        response: {
          statusCode: res.status ?? 200,
          headers: res.headers ?? {},
          body: Readable.from([Buffer.from(res.body ?? '')]),
        },
      };
    },
  };
  const client = new S3Client({
    region: 'us-east-1',
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: 'test-access', secretAccessKey: 'test-secret' },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    maxAttempts: 1,
    requestHandler,
  });
  return { client, requests };
}

/** Minimal S3 multipart protocol: initiate → parts (ETag per part) → complete. */
function multipartReply(failPart?: number): (req: Recorded) => FakeResponse {
  return (req) => {
    if (req.method === 'POST' && 'uploads' in req.query) {
      return {
        body: '<InitiateMultipartUploadResult><Bucket>uploads</Bucket><Key>k</Key><UploadId>up-1</UploadId></InitiateMultipartUploadResult>',
      };
    }
    if (req.method === 'PUT' && req.query.partNumber !== undefined) {
      if (Number(req.query.partNumber) === failPart) {
        return { status: 500, body: '<Error><Code>InternalError</Code></Error>' };
      }
      return { headers: { etag: `"part-${String(req.query.partNumber)}"` } };
    }
    if (req.method === 'POST' && req.query.uploadId === 'up-1') {
      return {
        body: '<CompleteMultipartUploadResult><Bucket>uploads</Bucket><Key>k</Key><ETag>"final-3"</ETag></CompleteMultipartUploadResult>',
      };
    }
    if (req.method === 'DELETE' && req.query.uploadId === 'up-1') return { status: 204 };
    return { status: 400, body: '<Error><Code>Unexpected</Code></Error>' };
  };
}

/** Unknown-length stream: yields `total` bytes in 1 MiB chunks (never one big buffer). */
function generatedStream(total: number): Readable {
  const chunk = Buffer.alloc(1024 * 1024, 7);
  return Readable.from(
    (function* () {
      for (let sent = 0; sent < total; sent += chunk.length) {
        yield chunk.subarray(0, Math.min(chunk.length, total - sent));
      }
    })(),
  );
}

describe('S3StorageDriver.upload', () => {
  it('sends a small body as a single PutObject with type and metadata', async () => {
    const { client, requests } = fakeS3(() => ({ headers: { etag: '"abc123"' } }));
    const driver = new S3StorageDriver(cfg, { client });

    const stored = await driver.upload({
      key: 'users/u1/0199-a.txt',
      body: Buffer.from('hello'),
      contentType: 'text/plain',
      metadata: { owner: 'u1' },
      cacheControl: 'private, max-age=60',
    });

    expect(stored).toEqual({
      key: 'users/u1/0199-a.txt',
      size: 5,
      contentType: 'text/plain',
      etag: 'abc123',
    });
    expect(requests).toHaveLength(1);
    const [put] = requests;
    expect(put).toMatchObject({ method: 'PUT', path: '/uploads/users/u1/0199-a.txt' });
    expect(put?.headers).toMatchObject({
      'content-type': 'text/plain',
      'x-amz-meta-owner': 'u1',
      'cache-control': 'private, max-age=60',
    });
    expect(put?.body.toString()).toBe('hello');
    // WHEN_REQUIRED: no CRC32 checksum header (S3-compatibles reject it).
    expect(Object.keys(put?.headers ?? {}).some((h) => h.startsWith('x-amz-checksum-'))).toBe(
      false,
    );
  });

  it('streams an unknown-length body as a multipart upload', async () => {
    const total = 2 * S3_UPLOAD_PART_SIZE + 1024 * 1024; // 17 MiB → parts of 8 + 8 + 1 MiB
    const { client, requests } = fakeS3(multipartReply());
    const driver = new S3StorageDriver(cfg, { client });

    const stored = await driver.upload({
      key: 'users/u1/big.bin',
      body: generatedStream(total),
      contentType: 'application/octet-stream',
    });

    const parts = requests.filter((r) => r.query.partNumber !== undefined);
    expect(parts.map((p) => p.body.length).sort((a, b) => b - a)).toEqual([
      S3_UPLOAD_PART_SIZE,
      S3_UPLOAD_PART_SIZE,
      1024 * 1024,
    ]);
    expect(requests[0]).toMatchObject({ method: 'POST', path: '/uploads/users/u1/big.bin' });
    expect(requests.at(-1)?.body.toString()).toContain('<PartNumber>3</PartNumber>');
    expect(stored).toMatchObject({ key: 'users/u1/big.bin', size: total, etag: 'final-3' });
  });

  it('aborts the multipart upload and maps SDK failures to a generic 502', async () => {
    const { client, requests } = fakeS3(multipartReply(2));
    const driver = new S3StorageDriver(cfg, { client });

    const promise = driver.upload({
      key: 'users/u1/big.bin',
      body: generatedStream(2 * S3_UPLOAD_PART_SIZE + 1),
      contentType: 'application/octet-stream',
    });

    await expect(promise).rejects.toBeInstanceOf(ExternalServiceException);
    await expect(promise).rejects.toMatchObject({
      code: 'STORAGE_ERROR',
      message: 'Object storage request failed',
      details: { operation: 'upload' },
    });
    expect(requests.some((r) => r.method === 'DELETE' && r.query.uploadId === 'up-1')).toBe(true);
  });

  it('rejects an invalid key before any network call', async () => {
    const { client, requests } = fakeS3();
    const driver = new S3StorageDriver(cfg, { client });

    await expect(
      driver.upload({ key: '../etc/passwd', body: Buffer.from('x'), contentType: 'text/plain' }),
    ).rejects.toBeInstanceOf(DomainValidationException);
    expect(requests).toHaveLength(0);
  });

  it('keeps non-SDK errors (e.g. the client aborting its multipart stream) unchanged', async () => {
    const { client } = fakeS3();
    const driver = new S3StorageDriver(cfg, { client });
    const tooLarge = Object.assign(new Error('File too large'), { status: 413 });
    const body = new Readable({
      read() {
        this.destroy(tooLarge);
      },
    });

    await expect(
      driver.upload({ key: 'users/u1/a.bin', body, contentType: 'application/octet-stream' }),
    ).rejects.toBe(tooLarge);
  });
});

describe('S3StorageDriver.head / delete', () => {
  it('maps HeadObject output', async () => {
    const { client, requests } = fakeS3(() => ({
      headers: {
        'content-length': '42',
        'content-type': 'image/png',
        'last-modified': 'Wed, 01 Jan 2025 00:00:00 GMT',
        etag: '"e1"',
        'x-amz-meta-owner': 'u1',
      },
    }));
    const driver = new S3StorageDriver(cfg, { client });

    await expect(driver.head('users/u1/a.png')).resolves.toEqual({
      key: 'users/u1/a.png',
      size: 42,
      contentType: 'image/png',
      lastModified: new Date('2025-01-01T00:00:00Z'),
      etag: 'e1',
      metadata: { owner: 'u1' },
    });
    expect(requests[0]).toMatchObject({ method: 'HEAD', path: '/uploads/users/u1/a.png' });
  });

  it('returns null for a missing key', async () => {
    const { client } = fakeS3(() => ({ status: 404 }));

    await expect(new S3StorageDriver(cfg, { client }).head('users/u1/nope')).resolves.toBeNull();
  });

  it('surfaces other failures as ExternalServiceException', async () => {
    const { client } = fakeS3(() => ({ status: 403 }));

    await expect(new S3StorageDriver(cfg, { client }).head('users/u1/a')).rejects.toMatchObject({
      code: 'STORAGE_ERROR',
      details: { operation: 'head' },
    });
  });

  it('deletes by key (idempotent on the S3 side)', async () => {
    const { client, requests } = fakeS3(() => ({ status: 204 }));

    await new S3StorageDriver(cfg, { client }).delete('users/u1/a.png');

    expect(requests[0]).toMatchObject({ method: 'DELETE', path: '/uploads/users/u1/a.png' });
  });
});

describe('S3StorageDriver presigned URLs', () => {
  // Presigning is local: the default presign client (public endpoint) never touches the network.
  const driver = (): S3StorageDriver => new S3StorageDriver(cfg, { client: fakeS3().client });

  it('signs uploads for the PUBLIC endpoint with content-type (and length) in the signature', async () => {
    const before = Date.now();
    const presigned = await driver().createPresignedUpload('users/u1/a.png', {
      contentType: 'image/png',
      contentLength: 1234,
    });

    const url = new URL(presigned.url);
    expect(url.origin).toBe('http://localhost:9000');
    expect(url.pathname).toBe('/uploads/users/u1/a.png');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host');
    expect(url.searchParams.get('X-Amz-Credential')).toMatch(/^test-access\//);
    expect(presigned).toMatchObject({
      key: 'users/u1/a.png',
      method: 'PUT',
      headers: { 'content-type': 'image/png' },
    });
    expect(presigned.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 900_000);
  });

  it('clamps the TTL to 7 days', async () => {
    const presigned = await driver().createPresignedUpload('users/u1/a.png', {
      contentType: 'image/png',
      expiresInSec: 10 ** 9,
    });

    expect(new URL(presigned.url).searchParams.get('X-Amz-Expires')).toBe('604800');
    expect(new URL(presigned.url).searchParams.get('X-Amz-SignedHeaders')).toBe(
      'content-type;host',
    );
  });

  it('signs downloads, optionally forcing an attachment filename', async () => {
    const { url } = await driver().createPresignedDownload('users/u1/a.pdf', {
      filename: 'Report 2025.pdf',
      expiresInSec: 60,
    });

    const parsed = new URL(url);
    expect(parsed.origin).toBe('http://localhost:9000');
    expect(parsed.searchParams.get('X-Amz-Expires')).toBe('60');
    expect(parsed.searchParams.get('response-content-disposition')).toBe(
      `attachment; filename="report-2025.pdf"; filename*=UTF-8''Report%202025.pdf`,
    );
  });

  it('reuses the main client when public and internal endpoints are equal', async () => {
    const same = storageConfig.parse({ S3_ENDPOINT: 'http://localhost:9000' });
    const { client } = fakeS3(undefined, same.s3.endpoint);
    const destroy = vi.spyOn(client, 'destroy');

    const d = new S3StorageDriver(same, { client });
    const { url } = await d.createPresignedDownload('a.txt');
    d.onModuleDestroy();

    expect(new URL(url).origin).toBe('http://localhost:9000');
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});

describe('S3StorageDriver lifecycle', () => {
  it('destroys both clients on module destroy', () => {
    const client = fakeS3().client;
    const presignClient = fakeS3().client;
    const a = vi.spyOn(client, 'destroy');
    const b = vi.spyOn(presignClient, 'destroy');

    new S3StorageDriver(cfg, { client, presignClient }).onModuleDestroy();

    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });
});

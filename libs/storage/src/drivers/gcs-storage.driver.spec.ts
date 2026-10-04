import { Readable, Writable } from 'node:stream';
import { DomainValidationException, ExternalServiceException } from '@app/common';
import { storageConfig } from '@app/config';
import { ApiError, type Storage } from '@google-cloud/storage';
import { describe, expect, it, vi } from 'vitest';
import {
  createGcsClient,
  GcsStorageDriver,
  isGoogleStorageEndpoint,
} from './gcs-storage.driver.js';

const cfg = storageConfig.parse({
  STORAGE_DRIVER: 'gcs',
  GCS_BUCKET: 'uploads',
  GCS_PROJECT_ID: 'local-project',
  GCS_API_ENDPOINT: 'http://localhost:4443',
});

function apiError(code: number, message = 'boom'): ApiError {
  return Object.assign(new ApiError(message), { code });
}

/** In-memory stand-in for `Bucket`/`File`: records what the driver asks the SDK to do. */
function fakeGcs() {
  const written = new Map<string, Buffer>();
  const file = {
    name: '',
    metadata: {} as Record<string, unknown>,
    save: vi.fn(async (data: Buffer, _options?: unknown) => {
      written.set(file.name, data);
      file.metadata = { size: String(data.length), etag: '"e-save"' };
    }),
    createWriteStream: vi.fn(() => {
      const chunks: Buffer[] = [];
      return new Writable({
        write(chunk: Buffer, _enc, cb) {
          chunks.push(chunk);
          cb();
        },
        final(cb) {
          const data = Buffer.concat(chunks);
          written.set(file.name, data);
          file.metadata = { size: String(data.length), etag: '"e-stream"' };
          cb();
        },
      });
    }),
    getSignedUrl: vi.fn(async () => ['https://signed.example/url']),
    getMetadata: vi.fn(async (): Promise<[Record<string, unknown>]> => [{}]),
    delete: vi.fn(async () => [{}]),
  };
  const bucket = {
    name: 'uploads',
    file: vi.fn((name: string) => {
      file.name = name;
      return file;
    }),
  };
  const storage = { bucket: vi.fn(() => bucket) } as unknown as Storage;
  return { storage, bucket, file, written };
}

describe('isGoogleStorageEndpoint', () => {
  it('distinguishes Google from emulators', () => {
    expect(isGoogleStorageEndpoint('https://storage.googleapis.com')).toBe(true);
    expect(isGoogleStorageEndpoint('https://storage.europe-west1.rep.googleapis.com')).toBe(true);
    expect(isGoogleStorageEndpoint('http://localhost:4443')).toBe(false);
    expect(isGoogleStorageEndpoint('not a url')).toBe(false);
  });
});

describe('GcsStorageDriver.upload', () => {
  it('pipes streams into a single-request write stream (no buffering, crc32c validated)', async () => {
    const { storage, file, written } = fakeGcs();
    const driver = new GcsStorageDriver(cfg, storage);

    const stored = await driver.upload({
      key: 'users/u1/a.txt',
      body: Readable.from([Buffer.from('hel'), Buffer.from('lo')]),
      contentType: 'text/plain',
      metadata: { owner: 'u1' },
    });

    expect(file.save).not.toHaveBeenCalled();
    expect(file.createWriteStream).toHaveBeenCalledWith({
      resumable: false,
      contentType: 'text/plain',
      validation: 'crc32c',
      metadata: { contentType: 'text/plain', metadata: { owner: 'u1' } },
    });
    expect(written.get('users/u1/a.txt')?.toString()).toBe('hello');
    expect(stored).toEqual({
      key: 'users/u1/a.txt',
      size: 5,
      contentType: 'text/plain',
      etag: 'e-stream',
    });
  });

  it('uses save() for buffers', async () => {
    const { storage, file } = fakeGcs();

    const stored = await new GcsStorageDriver(cfg, storage).upload({
      key: 'users/u1/b.bin',
      body: Buffer.from([1, 2, 3]),
      contentType: 'application/octet-stream',
      cacheControl: 'no-store',
    });

    expect(file.save).toHaveBeenCalledOnce();
    expect(file.save.mock.calls[0]?.[1]).toMatchObject({
      metadata: { cacheControl: 'no-store' },
    });
    expect(stored).toMatchObject({ size: 3, etag: 'e-save' });
  });

  it('maps SDK errors to ExternalServiceException', async () => {
    const { storage, file } = fakeGcs();
    file.save.mockRejectedValueOnce(apiError(503));

    await expect(
      new GcsStorageDriver(cfg, storage).upload({
        key: 'a.bin',
        body: Buffer.from('x'),
        contentType: 'application/octet-stream',
      }),
    ).rejects.toBeInstanceOf(ExternalServiceException);
  });

  it('rejects invalid keys', async () => {
    const { storage, bucket } = fakeGcs();

    await expect(
      new GcsStorageDriver(cfg, storage).upload({
        key: 'a/../b',
        body: Buffer.from('x'),
        contentType: 'text/plain',
      }),
    ).rejects.toBeInstanceOf(DomainValidationException);
    expect(bucket.file).not.toHaveBeenCalled();
  });
});

describe('GcsStorageDriver presigned URLs', () => {
  it('signs v4 PUT with content-type and a content-length range', async () => {
    const { storage, file } = fakeGcs();

    const presigned = await new GcsStorageDriver(cfg, storage).createPresignedUpload(
      'users/u1/a.png',
      { contentType: 'image/png', contentLength: 2048, expiresInSec: 60 },
    );

    expect(file.getSignedUrl).toHaveBeenCalledWith({
      version: 'v4',
      action: 'write',
      expires: presigned.expiresAt,
      contentType: 'image/png',
      extensionHeaders: { 'x-goog-content-length-range': '0,2048' },
    });
    expect(presigned).toMatchObject({
      key: 'users/u1/a.png',
      url: 'https://signed.example/url',
      method: 'PUT',
      headers: { 'content-type': 'image/png', 'x-goog-content-length-range': '0,2048' },
    });
    expect(presigned.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(60_000);
  });

  it('signs v4 GET with an attachment disposition', async () => {
    const { storage, file } = fakeGcs();

    await new GcsStorageDriver(cfg, storage).createPresignedDownload('users/u1/a.pdf', {
      filename: 'a.pdf',
    });

    expect(file.getSignedUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'read',
        responseDisposition: `attachment; filename="a.pdf"; filename*=UTF-8''a.pdf`,
      }),
    );
  });

  it('signs locally with the ephemeral emulator key (no network)', async () => {
    const driver = new GcsStorageDriver(cfg, createGcsClient(cfg.gcs));

    const { url } = await driver.createPresignedDownload('users/u1/a.png', { expiresInSec: 120 });

    const parsed = new URL(url);
    expect(parsed.origin).toBe('http://localhost:4443');
    expect(parsed.pathname).toBe('/uploads/users/u1/a.png');
    expect(parsed.searchParams.get('X-Goog-Algorithm')).toBe('GOOG4-RSA-SHA256');
    expect(parsed.searchParams.get('X-Goog-Expires')).toBe('120');
    expect(parsed.searchParams.get('X-Goog-Credential')).toMatch(
      /^emulator@local-project\.iam\.gserviceaccount\.com\//,
    );
    expect(parsed.searchParams.get('X-Goog-Signature')).toMatch(/^[0-9a-f]{512}$/);
  });
});

describe('GcsStorageDriver.head / delete', () => {
  it('maps metadata and normalizes custom metadata to strings', async () => {
    const { storage, file } = fakeGcs();
    file.getMetadata.mockResolvedValueOnce([
      {
        size: '42',
        contentType: 'image/png',
        updated: '2025-01-01T00:00:00.000Z',
        etag: 'CJ+T',
        metadata: { owner: 'u1', version: 3, dropped: null },
      },
    ]);

    await expect(new GcsStorageDriver(cfg, storage).head('users/u1/a.png')).resolves.toEqual({
      key: 'users/u1/a.png',
      size: 42,
      contentType: 'image/png',
      lastModified: new Date('2025-01-01T00:00:00.000Z'),
      etag: 'CJ+T',
      metadata: { owner: 'u1', version: '3' },
    });
  });

  it('returns null for 404 and wraps other API errors', async () => {
    const { storage, file } = fakeGcs();
    const driver = new GcsStorageDriver(cfg, storage);

    file.getMetadata.mockRejectedValueOnce(apiError(404, 'No such object'));
    await expect(driver.head('users/u1/missing')).resolves.toBeNull();

    file.getMetadata.mockRejectedValueOnce(apiError(403, 'forbidden'));
    await expect(driver.head('users/u1/secret')).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
  });

  it('deletes idempotently', async () => {
    const { storage, file } = fakeGcs();

    await new GcsStorageDriver(cfg, storage).delete('users/u1/a.png');

    expect(file.delete).toHaveBeenCalledWith({ ignoreNotFound: true });
  });
});

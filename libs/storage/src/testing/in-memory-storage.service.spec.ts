import { Readable } from 'node:stream';
import { DomainValidationException } from '@app/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { StorageService } from '../storage.service.js';
import { InMemoryStorageService } from './in-memory-storage.service.js';

describe('InMemoryStorageService (StorageService contract)', () => {
  let storage: InMemoryStorageService;

  beforeEach(() => {
    storage = new InMemoryStorageService({ signedUrlTtlSec: 300 });
  });

  it('is a StorageService bound to the "memory" driver', () => {
    expect(storage).toBeInstanceOf(StorageService);
    expect(storage.driver).toBe('memory');
  });

  it('stores buffers and consumes streams to the end', async () => {
    const a = await storage.upload({
      key: 'users/u1/a.txt',
      body: Buffer.from('hello'),
      contentType: 'text/plain',
      metadata: { owner: 'u1' },
    });
    const b = await storage.upload({
      key: 'users/u1/b.txt',
      body: Readable.from(['wor', 'ld!']),
      contentType: 'text/plain',
    });

    expect(a).toEqual({
      key: 'users/u1/a.txt',
      size: 5,
      contentType: 'text/plain',
      etag: '5d41402abc4b2a76b9719d911017c592', // md5('hello'), like S3 single-part ETags
    });
    expect(b.size).toBe(6);
    expect(storage.getObject('users/u1/b.txt')?.body.toString()).toBe('world!');
    expect(storage.listKeys('users/u1/')).toEqual(['users/u1/a.txt', 'users/u1/b.txt']);
  });

  it('heads existing objects and returns null for missing ones', async () => {
    await storage.upload({
      key: 'k.bin',
      body: Buffer.from([1, 2]),
      contentType: 'application/octet-stream',
      metadata: { a: '1' },
    });

    await expect(storage.head('k.bin')).resolves.toMatchObject({
      key: 'k.bin',
      size: 2,
      contentType: 'application/octet-stream',
      metadata: { a: '1' },
    });
    await expect(storage.head('missing.bin')).resolves.toBeNull();
  });

  it('overwrites on re-upload and deletes idempotently', async () => {
    await storage.upload({ key: 'k', body: Buffer.from('1'), contentType: 'text/plain' });
    await storage.upload({ key: 'k', body: Buffer.from('22'), contentType: 'text/csv' });

    await expect(storage.head('k')).resolves.toMatchObject({ size: 2, contentType: 'text/csv' });

    await storage.delete('k');
    await storage.delete('k');
    await expect(storage.head('k')).resolves.toBeNull();
  });

  it('builds presigned URLs with the default TTL and signed headers', async () => {
    const before = Date.now();
    const upload = await storage.createPresignedUpload('users/u1/a b.png', {
      contentType: 'image/png',
    });
    const download = await storage.createPresignedDownload('users/u1/a b.png', {
      filename: 'a b.png',
      expiresInSec: 10 ** 9,
    });

    expect(upload).toMatchObject({
      method: 'PUT',
      headers: { 'content-type': 'image/png' },
    });
    const up = new URL(upload.url);
    expect(up.pathname).toBe('/users/u1/a%20b.png');
    expect(up.searchParams.get('expires')).toBe('300');
    expect(upload.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 300_000);

    const down = new URL(download.url);
    expect(down.searchParams.get('expires')).toBe('604800'); // clamped to 7 days
    expect(down.searchParams.get('response-content-disposition')).toMatch(/^attachment;/);
  });

  it('validates keys like the real drivers', async () => {
    await expect(
      storage.upload({ key: '/abs', body: Buffer.from('x'), contentType: 'text/plain' }),
    ).rejects.toBeInstanceOf(DomainValidationException);
    await expect(storage.head('a//b')).rejects.toBeInstanceOf(DomainValidationException);
    await expect(storage.delete('..')).rejects.toBeInstanceOf(DomainValidationException);
    await expect(
      storage.createPresignedUpload('a\nb', { contentType: 'text/plain' }),
    ).rejects.toBeInstanceOf(DomainValidationException);
  });

  it('clear() empties the store', async () => {
    await storage.upload({ key: 'k', body: Buffer.from('x'), contentType: 'text/plain' });

    storage.clear();

    expect(storage.listKeys()).toEqual([]);
  });
});

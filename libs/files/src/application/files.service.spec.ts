import { Readable } from 'node:stream';
import { makeAuthUser, Role } from '@app/auth';
import { DomainValidationException, generateId } from '@app/common';
import { type StorageConfig, storageConfig } from '@app/config';
import { InMemoryStorageService, type StorageService, type StoredObject } from '@app/storage';
import { createMock } from '@app/testing';
import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  FileAccessDeniedException,
  FileNotFoundException,
  FileTooLargeException,
  UnsupportedFileTypeException,
  UploadCapacityExceededException,
} from '../domain/files.errors.js';
import { FilesService, UPLOADED_BY_METADATA_KEY } from './files.service.js';

const config: StorageConfig = storageConfig.parse({ STORAGE_MAX_UPLOAD_BYTES: '1000' });

describe('FilesService', () => {
  const alice = makeAuthUser({ roles: [Role.User] });
  const bob = makeAuthUser({ roles: [Role.User] });
  const admin = makeAuthUser({ roles: [Role.Admin] });
  let storage: InMemoryStorageService;
  let service: FilesService;

  // The service is built without a Nest app: keep its debug/audit lines out of the test output.
  beforeAll(() => Logger.overrideLogger(false));
  afterAll(() => Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose', 'fatal']));

  beforeEach(() => {
    storage = new InMemoryStorageService();
    service = new FilesService(storage, config);
  });

  const put = async (ownerId: string, name = 'a.txt'): Promise<string> => {
    const key = `users/${ownerId}/${generateId()}-${name}`;
    await storage.upload({ key, body: Buffer.from('data'), contentType: 'text/plain' });
    return key;
  };

  it('exposes the configured upload limit for the edge', () => {
    expect(service.maxUploadBytes).toBe(1000);
  });

  describe('upload', () => {
    it('streams to a fresh key under the actor prefix with normalized type and owner metadata', async () => {
      const result = await service.upload(alice, {
        filename: 'My Photo.PNG',
        contentType: 'IMAGE/PNG',
        body: Readable.from([Buffer.from('png'), Buffer.from('bytes')]),
      });

      expect(result).toEqual({
        key: expect.stringMatching(new RegExp(`^users/${alice.id}/[0-9a-f-]{36}-my-photo\\.png$`)),
        filename: 'my-photo.png',
        contentType: 'image/png',
        size: 8,
        etag: expect.any(String),
      });
      expect(storage.getObject(result.key)).toMatchObject({
        contentType: 'image/png',
        metadata: { [UPLOADED_BY_METADATA_KEY]: alice.id },
      });
    });

    it('hands the stream itself to the storage port (no buffering)', async () => {
      const port = createMock<StorageService>({
        upload: async (input: { key: string; contentType: string }) => ({
          key: input.key,
          contentType: input.contentType,
        }),
      });
      const body = Readable.from(['x']);

      await new FilesService(port, config).upload(alice, {
        filename: 'a.txt',
        contentType: 'text/plain',
        body,
      });

      expect(port.upload).toHaveBeenCalledWith(expect.objectContaining({ body }));
    });

    it('rejects a disallowed type before touching storage', async () => {
      await expect(
        service.upload(alice, {
          filename: 'x.svg',
          contentType: 'image/svg+xml',
          body: Readable.from([]),
        }),
      ).rejects.toBeInstanceOf(UnsupportedFileTypeException);
      expect(storage.listKeys()).toEqual([]);
    });

    it('propagates stream failures (e.g. the parser limit) without storing anything', async () => {
      const failing = new Readable({
        read() {
          this.destroy(new Error('limit reached'));
        },
      });
      await expect(
        service.upload(alice, { filename: 'a.txt', contentType: 'text/plain', body: failing }),
      ).rejects.toThrow('limit reached');
      expect(storage.listKeys()).toEqual([]);
    });
  });

  describe('upload concurrency cap (STORAGE_MAX_CONCURRENT_UPLOADS)', () => {
    const MAX = 2;
    const capped: StorageConfig = storageConfig.parse({
      STORAGE_MAX_UPLOAD_BYTES: '1000',
      STORAGE_MAX_CONCURRENT_UPLOADS: String(MAX),
    });

    /** A storage port whose uploads stay pending until the test settles them one by one. */
    function slowStorage() {
      const pending: { resolve: () => void; reject: (error: Error) => void }[] = [];
      const port = createMock<StorageService>({
        upload: (input: { key: string; contentType: string }) =>
          new Promise<StoredObject>((resolve, reject) => {
            pending.push({
              resolve: () => resolve({ key: input.key, contentType: input.contentType }),
              reject,
            });
          }),
      });
      return { port, pending };
    }

    const params = () => ({
      filename: 'a.txt',
      contentType: 'text/plain',
      body: Readable.from(['x']),
    });

    it('rejects upload N+1 with a 503 before touching storage while N are in flight', async () => {
      const { port, pending } = slowStorage();
      const files = new FilesService(port, capped);

      const inFlight = Array.from({ length: MAX }, () => files.upload(alice, params()));
      const extra = files.upload(bob, params());

      await expect(extra).rejects.toBeInstanceOf(UploadCapacityExceededException);
      await expect(extra).rejects.toMatchObject({
        code: 'UPLOAD_CAPACITY_EXCEEDED',
        httpStatus: 503,
        retryAfterSec: 5,
        details: { maxConcurrentUploads: MAX, retryAfterSec: 5 },
      });
      expect(port.upload).toHaveBeenCalledTimes(MAX);

      for (const p of pending) p.resolve();
      await expect(Promise.all(inFlight)).resolves.toHaveLength(MAX);
    });

    it('frees the slot when an upload completes and when it fails', async () => {
      const { port, pending } = slowStorage();
      const files = new FilesService(port, capped);

      const ok = files.upload(alice, params());
      const failing = files.upload(alice, params());
      await expect(files.upload(alice, params())).rejects.toBeInstanceOf(
        UploadCapacityExceededException,
      );

      pending[0]?.resolve();
      await ok;
      const afterSuccess = files.upload(alice, params()); // takes the freed slot
      expect(port.upload).toHaveBeenCalledTimes(3);

      pending[1]?.reject(new Error('bucket down'));
      await expect(failing).rejects.toThrow('bucket down');
      const afterFailure = files.upload(alice, params()); // takes the slot of the failed one
      expect(port.upload).toHaveBeenCalledTimes(4);
      await expect(files.upload(alice, params())).rejects.toBeInstanceOf(
        UploadCapacityExceededException,
      );

      for (const p of pending.slice(2)) p.resolve();
      await Promise.all([afterSuccess, afterFailure]);
    });

    it('checks the content type first: a 415 never takes (or leaks) a slot', async () => {
      const { port, pending } = slowStorage();
      const files = new FilesService(port, capped);
      const svg = { ...params(), contentType: 'image/svg+xml' };

      for (let i = 0; i <= MAX; i += 1) {
        await expect(files.upload(alice, svg)).rejects.toBeInstanceOf(UnsupportedFileTypeException);
      }
      const accepted = Array.from({ length: MAX }, () => files.upload(alice, params()));
      expect(port.upload).toHaveBeenCalledTimes(MAX);

      for (const p of pending) p.resolve();
      await Promise.all(accepted);
    });
  });

  describe('createUploadUrl', () => {
    it('presigns a PUT pinned to the normalized type and exact length', async () => {
      const port = createMock<StorageService>({
        createPresignedUpload: async (key: string) => ({
          key,
          url: 'https://bucket/x',
          method: 'PUT' as const,
          headers: { 'content-type': 'application/pdf' },
          expiresAt: new Date(Date.now() + 60_000),
        }),
      });

      const result = await new FilesService(port, config).createUploadUrl(alice, {
        filename: 'Report.pdf',
        contentType: 'Application/PDF',
        contentLength: 1000,
      });

      expect(port.createPresignedUpload).toHaveBeenCalledWith(
        expect.stringMatching(new RegExp(`^users/${alice.id}/[0-9a-f-]{36}-report\\.pdf$`)),
        { contentType: 'application/pdf', contentLength: 1000 },
      );
      expect(result).toMatchObject({
        filename: 'report.pdf',
        method: 'PUT',
        url: 'https://bucket/x',
      });
    });

    it('413s above STORAGE_MAX_UPLOAD_BYTES', async () => {
      const error = await service
        .createUploadUrl(alice, {
          filename: 'a.zip',
          contentType: 'application/zip',
          contentLength: 1001,
        })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(FileTooLargeException);
      expect(error).toMatchObject({ maxBytes: 1000 });
    });

    it.each([0, -1, 1.5, Number.NaN])(
      'rejects the non-positive-integer length %s',
      async (length) => {
        await expect(
          service.createUploadUrl(alice, {
            filename: 'a.png',
            contentType: 'image/png',
            contentLength: length,
          }),
        ).rejects.toBeInstanceOf(DomainValidationException);
      },
    );

    it('rejects a disallowed type', async () => {
      await expect(
        service.createUploadUrl(alice, {
          filename: 'a.html',
          contentType: 'text/html',
          contentLength: 1,
        }),
      ).rejects.toBeInstanceOf(UnsupportedFileTypeException);
    });
  });

  describe('createDownloadUrl', () => {
    it('presigns an attachment download of an own file', async () => {
      const key = await put(alice.id, 'notes.txt');
      const result = await service.createDownloadUrl(alice, key);

      expect(result).toMatchObject({
        key,
        filename: 'notes.txt',
        size: 4,
        contentType: 'text/plain',
      });
      expect(new URL(result.url).searchParams.get('response-content-disposition')).toContain(
        'attachment; filename="notes.txt"',
      );
    });

    it("denies another user's file before checking it exists", async () => {
      const port = createMock<StorageService>();
      const key = `users/${bob.id}/${generateId()}-a.txt`;

      await expect(
        new FilesService(port, config).createDownloadUrl(alice, key),
      ).rejects.toBeInstanceOf(FileAccessDeniedException);
      expect(port.head).not.toHaveBeenCalled();
    });

    it("lets files:manage reach any user's file", async () => {
      const key = await put(bob.id);
      await expect(service.createDownloadUrl(admin, key)).resolves.toMatchObject({ key });
    });

    it('404s for a missing authorized key', async () => {
      await expect(
        service.createDownloadUrl(alice, `users/${alice.id}/${generateId()}-gone.txt`),
      ).rejects.toBeInstanceOf(FileNotFoundException);
    });

    it('422s on malformed keys (traversal cannot dodge the prefix check)', async () => {
      await expect(
        service.createDownloadUrl(alice, `users/${alice.id}/../${bob.id}/a.txt`),
      ).rejects.toMatchObject({ code: 'INVALID_STORAGE_KEY' });
    });
  });

  describe('deleteFile', () => {
    it('deletes own files, and is idempotent', async () => {
      const key = await put(alice.id);
      await service.deleteFile(alice, key);
      expect(storage.getObject(key)).toBeUndefined();
      await expect(service.deleteFile(alice, key)).resolves.toBeUndefined();
    });

    it("denies another user's file and keeps it", async () => {
      const key = await put(bob.id);
      await expect(service.deleteFile(alice, key)).rejects.toBeInstanceOf(
        FileAccessDeniedException,
      );
      expect(storage.getObject(key)).toBeDefined();
    });

    it("lets files:manage delete any user's file", async () => {
      const key = await put(bob.id);
      await service.deleteFile(admin, key);
      expect(storage.getObject(key)).toBeUndefined();
    });
  });
});

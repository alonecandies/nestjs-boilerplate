import { Role } from '@app/auth';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFilesTestApp, type FilesTestApp } from '../../testing/files-test-app.test.js';

/**
 * The apps boot with `createHttpApp({ multipart: true })`, which registers @fastify/multipart with
 * bootstrap's own limits (25 MiB/file, 10 files, 50 fields). STORAGE_MAX_UPLOAD_BYTES must win
 * over those in both directions, because the route merges its limits over the plugin's.
 */
describe('upload limits when the adapter pre-registers @fastify/multipart', () => {
  const upload = async (t: FilesTestApp, bytes: number) => {
    const form = new FormData();
    form.append('file', new Blob([Buffer.alloc(bytes, 'a')], { type: 'text/plain' }), 'a.txt');
    return t.app.inject({
      method: 'POST',
      url: '/v1/files',
      headers: { authorization: `Bearer ${await t.tokenFor([Role.User])}` },
      payload: form,
    });
  };

  describe('plugin limit above STORAGE_MAX_UPLOAD_BYTES', () => {
    let t: FilesTestApp;
    beforeAll(async () => {
      t = await createFilesTestApp({
        maxUploadBytes: 1024,
        adapter: new FastifyAdapter({
          multipart: { limits: { fileSize: 25 * 1024 * 1024, files: 10, fields: 50 } },
        }),
      });
    });
    afterAll(async () => t.app.close());

    it('still rejects what exceeds the configured limit (413)', async () => {
      const res = await upload(t, 2048);
      expect(res.statusCode).toBe(413);
      expect(res.json()).toMatchObject({ code: 'FILE_TOO_LARGE' });
    });

    it('still enforces one file and no fields', async () => {
      const form = new FormData();
      form.append('note', 'x');
      form.append('file', new Blob(['a'], { type: 'text/plain' }), 'a.txt');
      const res = await t.app.inject({
        method: 'POST',
        url: '/v1/files',
        headers: { authorization: `Bearer ${await t.tokenFor([Role.User])}` },
        payload: form,
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('plugin limit below STORAGE_MAX_UPLOAD_BYTES', () => {
    let t: FilesTestApp;
    beforeAll(async () => {
      t = await createFilesTestApp({
        maxUploadBytes: 8192,
        adapter: new FastifyAdapter({ multipart: { limits: { fileSize: 16 } } }),
      });
    });
    afterAll(async () => t.app.close());

    it('accepts what the configured limit allows', async () => {
      const res = await upload(t, 4096);
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ size: 4096 });
    });
  });
});

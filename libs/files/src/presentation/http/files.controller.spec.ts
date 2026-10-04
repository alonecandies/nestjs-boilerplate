import { Readable } from 'node:stream';
import { Role } from '@app/auth';
import { generateId, isUuidV7 } from '@app/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { UPLOADED_BY_METADATA_KEY } from '../../application/files.service.js';
import { createFilesTestApp, type FilesTestApp } from '../../testing/files-test-app.test.js';

const MAX_UPLOAD_BYTES = 4096;
const PROBLEM_JSON = /^application\/problem\+json/;

interface ProblemBody {
  status: number;
  code: string;
  detail?: string;
  errors?: { path?: string; message: string }[];
}

function fileForm(
  content: string | Buffer,
  { filename = 'Hello World.txt', type = 'text/plain', field = 'file' } = {},
): FormData {
  const form = new FormData();
  form.append(field, new Blob([content], { type }), filename);
  return form;
}

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

describe('FilesController (Fastify e2e, in-memory storage)', () => {
  let t: FilesTestApp;
  const aliceId = generateId();
  const bobId = generateId();
  let alice: string;
  let bob: string;
  let admin: string;
  let nobody: string;

  beforeAll(async () => {
    t = await createFilesTestApp({ maxUploadBytes: MAX_UPLOAD_BYTES });
    alice = await t.tokenFor([Role.User], aliceId);
    bob = await t.tokenFor([Role.User], bobId);
    admin = await t.tokenFor([Role.Admin]);
    // A valid token whose roles grant nothing (e.g. an unknown role dropped at verification).
    nobody = await t.tokenFor([]);
  });

  afterEach(() => t.storage.clear());
  afterAll(async () => t.app.close());

  const upload = (token: string, form: FormData) =>
    t.app.inject({ method: 'POST', url: '/v1/files', headers: bearer(token), payload: form });

  async function storedFileOf(userId: string, content = 'hello'): Promise<string> {
    const key = `users/${userId}/${generateId()}-notes.txt`;
    await t.storage.upload({ key, body: Buffer.from(content), contentType: 'text/plain' });
    return key;
  }

  describe('POST /v1/files (streaming multipart upload)', () => {
    it('streams the file part to storage under users/{userId}/{uuidv7}-{safeFilename}', async () => {
      const uploadSpy = vi.spyOn(t.storage, 'upload');
      const res = await upload(alice, fileForm('hello, world'));

      expect(res.statusCode).toBe(201);
      const body = res.json<Record<string, unknown>>();
      expect(body).toEqual({
        key: expect.stringMatching(
          new RegExp(`^users/${aliceId}/[0-9a-f-]{36}-hello-world\\.txt$`),
        ),
        filename: 'hello-world.txt',
        contentType: 'text/plain',
        size: 12,
        etag: expect.any(String),
      });
      const key = String(body['key']);
      expect(isUuidV7(key.split('/')[2]?.slice(0, 36))).toBe(true);

      // Never buffered by the API: storage received the multipart stream itself.
      expect(uploadSpy.mock.calls[0]?.[0].body).toBeInstanceOf(Readable);
      const stored = t.storage.getObject(key);
      expect(stored?.body.toString()).toBe('hello, world');
      expect(stored?.metadata).toEqual({ [UPLOADED_BY_METADATA_KEY]: aliceId });
    });

    it('accepts a file of exactly STORAGE_MAX_UPLOAD_BYTES', async () => {
      const res = await upload(alice, fileForm(Buffer.alloc(MAX_UPLOAD_BYTES, 'a')));
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ size: MAX_UPLOAD_BYTES });
    });

    it('rejects a file over the limit with 413 FILE_TOO_LARGE and stores nothing', async () => {
      const res = await upload(alice, fileForm(Buffer.alloc(MAX_UPLOAD_BYTES * 4, 'a')));

      expect(res.statusCode).toBe(413);
      expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
      expect(res.json<ProblemBody>()).toMatchObject({
        status: 413,
        code: 'FILE_TOO_LARGE',
        detail: expect.stringContaining(String(MAX_UPLOAD_BYTES)),
        errors: [
          { path: 'file', message: `must be at most ${MAX_UPLOAD_BYTES} bytes`, code: 'too_big' },
        ],
      });
      expect(t.storage.listKeys()).toEqual([]);
    });

    it('rejects a type outside the allow-list with 415 before reading the file', async () => {
      const uploadSpy = vi.spyOn(t.storage, 'upload');
      const res = await upload(
        alice,
        fileForm('<svg/>', { filename: 'x.svg', type: 'image/svg+xml' }),
      );

      expect(res.statusCode).toBe(415);
      expect(res.json<ProblemBody>()).toMatchObject({ code: 'UNSUPPORTED_FILE_TYPE' });
      expect(uploadSpy).not.toHaveBeenCalled();
    });

    it('400s when the request carries no file part', async () => {
      const res = await t.app.inject({
        method: 'POST',
        url: '/v1/files',
        headers: bearer(alice),
        payload: { file: 'not a file' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json<ProblemBody>()).toMatchObject({
        code: 'VALIDATION_FAILED',
        errors: [expect.objectContaining({ path: 'file' })],
      });
    });

    it('400s when the file is sent in another field', async () => {
      const res = await upload(alice, fileForm('hello', { field: 'attachment' }));
      expect(res.statusCode).toBe(400);
      expect(t.storage.listKeys()).toEqual([]);
    });

    it('400s on extra text fields (the file must be the only part)', async () => {
      const form = new FormData();
      form.append('description', 'hi');
      form.append('file', new Blob(['hello'], { type: 'text/plain' }), 'a.txt');

      const res = await upload(alice, form);
      expect(res.statusCode).toBe(400);
      expect(t.storage.listKeys()).toEqual([]);
    });

    it('401s without a (valid) access token', async () => {
      const anonymous = await t.app.inject({
        method: 'POST',
        url: '/v1/files',
        payload: fileForm('x'),
      });
      expect(anonymous.statusCode).toBe(401);
      expect(anonymous.headers['content-type']).toMatch(PROBLEM_JSON);

      const forged = await upload('not-a-jwt', fileForm('x'));
      expect(forged.statusCode).toBe(401);
    });

    it('403s without files:write', async () => {
      const res = await upload(nobody, fileForm('x'));
      expect(res.statusCode).toBe(403);
      expect(res.json<ProblemBody>()).toMatchObject({ code: 'FORBIDDEN' });
    });
  });

  describe('POST /v1/files/presigned-uploads', () => {
    const presign = (token: string, payload: Record<string, unknown>) =>
      t.app.inject({
        method: 'POST',
        url: '/v1/files/presigned-uploads',
        headers: bearer(token),
        payload,
      });

    it('returns a presigned PUT under the caller prefix with the signed headers', async () => {
      const res = await presign(alice, {
        filename: 'Quarterly Report.PDF',
        contentType: ' Application/PDF ',
        contentLength: 1234,
      });

      expect(res.statusCode).toBe(201);
      const body = res.json<Record<string, unknown>>();
      expect(body).toEqual({
        key: expect.stringMatching(
          new RegExp(`^users/${aliceId}/[0-9a-f-]{36}-quarterly-report\\.pdf$`),
        ),
        filename: 'quarterly-report.pdf',
        url: expect.stringContaining('method=PUT'),
        method: 'PUT',
        headers: { 'content-type': 'application/pdf' },
        expiresAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      });
      expect(Date.parse(String(body['expiresAt']))).toBeGreaterThan(Date.now());
    });

    it.each([
      [
        'a type outside the allow-list',
        { filename: 'a.svg', contentType: 'image/svg+xml', contentLength: 1 },
        'contentType',
      ],
      ['a missing filename', { contentType: 'image/png', contentLength: 1 }, 'filename'],
      [
        'a blank filename',
        { filename: '   ', contentType: 'image/png', contentLength: 1 },
        'filename',
      ],
      [
        'a zero length',
        { filename: 'a.png', contentType: 'image/png', contentLength: 0 },
        'contentLength',
      ],
      [
        'a fractional length',
        { filename: 'a.png', contentType: 'image/png', contentLength: 1.5 },
        'contentLength',
      ],
      [
        'a string length',
        { filename: 'a.png', contentType: 'image/png', contentLength: '12' },
        'contentLength',
      ],
    ])('400s on %s', async (_case, payload, path) => {
      const res = await presign(alice, payload);

      expect(res.statusCode).toBe(400);
      expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
      expect(res.json<ProblemBody>()).toMatchObject({
        code: 'VALIDATION_FAILED',
        errors: expect.arrayContaining([expect.objectContaining({ path })]),
      });
    });

    it('400s on unknown properties (strict body)', async () => {
      const res = await presign(alice, {
        filename: 'a.png',
        contentType: 'image/png',
        contentLength: 1,
        key: 'users/someone-else/x.png',
      });
      expect(res.statusCode).toBe(400);
    });

    it('413s when the announced size exceeds STORAGE_MAX_UPLOAD_BYTES', async () => {
      const res = await presign(alice, {
        filename: 'big.zip',
        contentType: 'application/zip',
        contentLength: MAX_UPLOAD_BYTES + 1,
      });
      expect(res.statusCode).toBe(413);
      expect(res.json<ProblemBody>()).toMatchObject({
        code: 'FILE_TOO_LARGE',
        errors: [expect.objectContaining({ path: 'contentLength' })],
      });
    });

    it('401s anonymously and 403s without files:write', async () => {
      const payload = { filename: 'a.png', contentType: 'image/png', contentLength: 1 };
      const anonymous = await t.app.inject({
        method: 'POST',
        url: '/v1/files/presigned-uploads',
        payload,
      });
      expect(anonymous.statusCode).toBe(401);
      expect((await presign(nobody, payload)).statusCode).toBe(403);
    });
  });

  describe('GET /v1/files/download-url', () => {
    const downloadUrl = (token: string, key?: string) =>
      t.app.inject({
        method: 'GET',
        url: '/v1/files/download-url',
        headers: bearer(token),
        ...(key === undefined ? {} : { query: { key } }),
      });

    it('presigns an attachment download of an own file', async () => {
      const key = await storedFileOf(aliceId, 'hello');
      const res = await downloadUrl(alice, key);

      expect(res.statusCode).toBe(200);
      const body = res.json<Record<string, unknown>>();
      expect(body).toEqual({
        key,
        filename: 'notes.txt',
        url: expect.stringContaining('method=GET'),
        expiresAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        size: 5,
        contentType: 'text/plain',
      });
      const url = new URL(String(body['url']));
      expect(url.searchParams.get('response-content-disposition')).toMatch(
        /^attachment; filename="notes\.txt"/,
      );
    });

    it("403s on another user's file (even one that exists)", async () => {
      const key = await storedFileOf(bobId);
      const res = await downloadUrl(alice, key);

      expect(res.statusCode).toBe(403);
      expect(res.json<ProblemBody>()).toMatchObject({ code: 'FILE_ACCESS_DENIED' });
    });

    it('does not confuse users/u1 with users/u10 (prefix boundary)', async () => {
      const key = await storedFileOf(`${aliceId}0`);
      expect((await downloadUrl(alice, key)).statusCode).toBe(403);
    });

    it("lets files:manage (admin) presign any user's file", async () => {
      const key = await storedFileOf(bobId);
      expect((await downloadUrl(admin, key)).statusCode).toBe(200);
    });

    it('404s for a missing own key', async () => {
      const res = await downloadUrl(alice, `users/${aliceId}/${generateId()}-gone.txt`);
      expect(res.statusCode).toBe(404);
      expect(res.json<ProblemBody>()).toMatchObject({ code: 'FILE_NOT_FOUND' });
    });

    it.each([
      ['missing', undefined],
      ['empty', ''],
      ['path traversal', 'users/me/../you/secret.txt'],
      ['a leading slash', '/users/me/a.txt'],
    ])('400s when the key is %s', async (_case, key) => {
      const res = await downloadUrl(alice, key);
      expect(res.statusCode).toBe(400);
      expect(res.json<ProblemBody>()).toMatchObject({
        code: 'VALIDATION_FAILED',
        errors: [expect.objectContaining({ path: 'key' })],
      });
    });

    it('401s anonymously', async () => {
      const res = await t.app.inject({
        method: 'GET',
        url: '/v1/files/download-url',
        query: { key: `users/${aliceId}/x.txt` },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('DELETE /v1/files', () => {
    const remove = (token: string, key: string) =>
      t.app.inject({ method: 'DELETE', url: '/v1/files', headers: bearer(token), query: { key } });

    it('deletes an own file (204)', async () => {
      const key = await storedFileOf(aliceId);
      const res = await remove(alice, key);

      expect(res.statusCode).toBe(204);
      expect(res.body).toBe('');
      expect(t.storage.getObject(key)).toBeUndefined();
    });

    it('is idempotent for an own key that no longer exists', async () => {
      const res = await remove(alice, `users/${aliceId}/${generateId()}-gone.txt`);
      expect(res.statusCode).toBe(204);
    });

    it("403s on another user's file and leaves it in place", async () => {
      const key = await storedFileOf(bobId);
      const res = await remove(alice, key);

      expect(res.statusCode).toBe(403);
      expect(res.json<ProblemBody>()).toMatchObject({ code: 'FILE_ACCESS_DENIED' });
      expect(t.storage.getObject(key)).toBeDefined();
    });

    it("lets files:manage (admin) delete any user's file", async () => {
      const key = await storedFileOf(bobId);
      expect((await remove(admin, key)).statusCode).toBe(204);
      expect(t.storage.getObject(key)).toBeUndefined();
    });

    it('403s without files:write or files:manage', async () => {
      const key = await storedFileOf(aliceId);
      expect((await remove(nobody, key)).statusCode).toBe(403);
    });

    it('400s on a traversal key', async () => {
      expect((await remove(alice, `users/${aliceId}/../${bobId}/a.txt`)).statusCode).toBe(400);
    });
  });

  describe('end to end: upload → download-url → delete', () => {
    it('round-trips a streamed upload with the returned key', async () => {
      const uploaded = await upload(
        bob,
        fileForm('%PDF-1.7', { filename: 'cv.pdf', type: 'application/pdf' }),
      );
      const { key } = uploaded.json<{ key: string }>();

      const download = await t.app.inject({
        method: 'GET',
        url: '/v1/files/download-url',
        headers: bearer(bob),
        query: { key },
      });
      expect(download.json()).toMatchObject({
        key,
        filename: 'cv.pdf',
        contentType: 'application/pdf',
      });

      const deleted = await t.app.inject({
        method: 'DELETE',
        url: '/v1/files',
        headers: bearer(bob),
        query: { key },
      });
      expect(deleted.statusCode).toBe(204);
      expect(t.storage.listKeys()).toEqual([]);
    });
  });

  describe('OpenAPI document', () => {
    it('documents the multipart body, the zod body/query and the responses', () => {
      const doc = SwaggerModule.createDocument(t.app, new DocumentBuilder().build());

      const uploadOp = doc.paths['/v1/files']?.post;
      expect(uploadOp?.requestBody).toMatchObject({
        required: true,
        content: {
          'multipart/form-data': {
            schema: {
              type: 'object',
              required: ['file'],
              properties: { file: { type: 'string', format: 'binary' } },
            },
          },
        },
      });
      expect(uploadOp?.responses).toHaveProperty('201');
      expect(uploadOp?.responses).toHaveProperty('413');
      expect(uploadOp?.security).toEqual([{ bearer: [] }]);

      const presignOp = doc.paths['/v1/files/presigned-uploads']?.post;
      expect(JSON.stringify(presignOp?.requestBody)).toContain('CreatePresignedUploadRequest');
      expect(doc.components?.schemas).toHaveProperty('CreatePresignedUploadRequest');
      expect(doc.components?.schemas).toHaveProperty('PresignedUpload');

      const downloadOp = doc.paths['/v1/files/download-url']?.get;
      expect(downloadOp?.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'key', in: 'query', required: true }),
        ]),
      );
      expect(doc.paths['/v1/files']?.delete?.responses).toHaveProperty('204');
    });
  });
});

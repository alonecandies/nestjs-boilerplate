import { describe, expect, it } from 'vitest';
import {
  DownloadUrlResponseSchema,
  PresignedUploadResponseSchema,
  UploadedFileResponseSchema,
} from './files.response.js';
import {
  toDownloadUrlResponse,
  toPresignedUploadResponse,
  toUploadedFileResponse,
} from './files-http.mapper.js';

const expiresAt = new Date('2026-09-29T10:00:00.000Z');

describe('files HTTP mappers', () => {
  it('maps an uploaded file, omitting unknown size/etag', () => {
    const full = toUploadedFileResponse({
      key: 'users/u/k-a.txt',
      filename: 'a.txt',
      contentType: 'text/plain',
      size: 3,
      etag: 'abc',
    });
    expect(full).toEqual({
      key: 'users/u/k-a.txt',
      filename: 'a.txt',
      contentType: 'text/plain',
      size: 3,
      etag: 'abc',
    });
    const partial = toUploadedFileResponse({ key: 'k', filename: 'a', contentType: 'text/plain' });
    expect(partial).toEqual({ key: 'k', filename: 'a', contentType: 'text/plain' });
    expect(UploadedFileResponseSchema.parse(partial)).toEqual(partial);
  });

  it('maps a presigned upload with an ISO expiry that satisfies its response schema', () => {
    const response = toPresignedUploadResponse({
      key: 'k',
      filename: 'a.png',
      url: 'https://bucket/k',
      method: 'PUT',
      headers: { 'content-type': 'image/png' },
      expiresAt,
    });
    expect(response.expiresAt).toBe('2026-09-29T10:00:00.000Z');
    expect(PresignedUploadResponseSchema.parse(response)).toEqual(response);
  });

  it('maps a download URL, omitting an unknown content type', () => {
    const response = toDownloadUrlResponse({
      key: 'k',
      filename: 'a.bin',
      url: 'https://bucket/k',
      expiresAt,
      size: 9,
      contentType: undefined,
    });
    expect(response).toEqual({
      key: 'k',
      filename: 'a.bin',
      url: 'https://bucket/k',
      expiresAt: '2026-09-29T10:00:00.000Z',
      size: 9,
    });
    expect(DownloadUrlResponseSchema.parse(response)).toEqual(response);
  });
});

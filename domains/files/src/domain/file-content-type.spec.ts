import { describe, expect, it } from 'vitest';
import {
  ALLOWED_UPLOAD_CONTENT_TYPE_PATTERN,
  ALLOWED_UPLOAD_CONTENT_TYPES,
} from '../files.constants.js';
import {
  assertAllowedContentType,
  isAllowedContentType,
  normalizeContentType,
} from './file-content-type.js';
import { UnsupportedFileTypeException } from './files.errors.js';

describe('file content-type policy', () => {
  it('accepts every allow-listed type, case- and whitespace-insensitively', () => {
    for (const type of ALLOWED_UPLOAD_CONTENT_TYPES) {
      expect(isAllowedContentType(type)).toBe(true);
      expect(isAllowedContentType(` ${type.toUpperCase()} `)).toBe(true);
    }
  });

  it.each([
    'image/svg+xml',
    'text/html',
    'application/x-msdownload',
    'application/octet-stream',
    'text/plain; charset=utf-8',
    'image/png2',
    'ximage/png',
    '',
  ])('rejects %j', (type) => {
    expect(isAllowedContentType(type)).toBe(false);
    expect(() => assertAllowedContentType(type)).toThrow(UnsupportedFileTypeException);
  });

  it('returns the normalized type the storage layer signs and stores', () => {
    expect(assertAllowedContentType(' Image/PNG ')).toBe('image/png');
    expect(normalizeContentType('\tTEXT/CSV\n')).toBe('text/csv');
  });

  it('anchors the pattern and escapes regex metacharacters (the "+" of subtypes, ".")', () => {
    expect(ALLOWED_UPLOAD_CONTENT_TYPE_PATTERN.source.startsWith('^(?:')).toBe(true);
    expect(ALLOWED_UPLOAD_CONTENT_TYPE_PATTERN.test('application/pdfx')).toBe(false);
    expect(ALLOWED_UPLOAD_CONTENT_TYPE_PATTERN.test('image/jpegimage/png')).toBe(false);
  });
});

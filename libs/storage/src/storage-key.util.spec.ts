import { DomainValidationException } from '@app/common';
import { describe, expect, it } from 'vitest';
import {
  assertStorageKey,
  attachmentContentDisposition,
  buildStorageKey,
  INVALID_STORAGE_KEY,
  isKeyWithinPrefix,
  MAX_SIGNED_URL_TTL_SEC,
  resolveSignedUrlTtlSec,
  unquoteEtag,
} from './storage-key.util.js';

describe('assertStorageKey', () => {
  it.each([
    'a.txt',
    'users/0199a3c1-7b2e-7cc0-8f1e-2f7c3b4d5e6f/0199a3c1-report.pdf',
    'users/u1/ünïcödé file (1).png',
  ])('accepts %j', (key) => {
    expect(assertStorageKey(key)).toBe(key);
  });

  it.each([
    ['', 'empty'],
    ['/leading', 'leading slash'],
    ['trailing/', 'trailing slash'],
    ['a//b', 'empty segment'],
    ['a/../b', 'dot-dot segment'],
    ['./a', 'dot segment'],
    ['a\\b', 'backslash'],
    ['a\u0000b', 'NUL'],
    ['a\nb', 'newline'],
    ['x'.repeat(1025), 'too long'],
    ['é'.repeat(513), 'too long in UTF-8 bytes (1026 bytes, 513 chars)'],
  ])('rejects %j (%s)', (key) => {
    expect(() => assertStorageKey(key)).toThrow(DomainValidationException);
    try {
      assertStorageKey(key);
    } catch (error) {
      expect(error).toMatchObject({ code: INVALID_STORAGE_KEY, httpStatus: 422 });
    }
  });
});

describe('buildStorageKey', () => {
  it('joins trimmed, non-empty segments', () => {
    expect(buildStorageKey('users', ' u1 ', '', 42, 'a.png')).toBe('users/u1/42/a.png');
  });

  it('validates the result', () => {
    expect(() => buildStorageKey('users', '..', 'a.png')).toThrow(DomainValidationException);
  });
});

describe('isKeyWithinPrefix', () => {
  it('matches keys strictly under the prefix directory', () => {
    expect(isKeyWithinPrefix('users/u1/a.png', 'users/u1')).toBe(true);
    expect(isKeyWithinPrefix('users/u1', 'users/u1')).toBe(false);
    expect(isKeyWithinPrefix('users/u1/', 'users/u1')).toBe(false);
    // Not fooled by a sibling sharing the prefix string.
    expect(isKeyWithinPrefix('users/u10/a.png', 'users/u1')).toBe(false);
  });
});

describe('attachmentContentDisposition', () => {
  it('emits an ASCII fallback and the exact UTF-8 name (RFC 6266)', () => {
    const header = attachmentContentDisposition('Résumé final.pdf');

    expect(header).toMatch(/^attachment; filename="[A-Za-z0-9._-]+\.pdf"; filename\*=UTF-8''/);
    expect(header).toContain("filename*=UTF-8''R%C3%A9sum%C3%A9%20final.pdf");
  });

  it('strips path components, quotes and control characters (no header splitting)', () => {
    const header = attachmentContentDisposition('../../etc/pa"ss\r\nX-Evil: 1.txt');

    expect(header).not.toMatch(/[\r\n]/);
    expect(header).not.toContain('etc');
    expect(header.split('"')).toHaveLength(3); // exactly one quoted filename
  });

  it('percent-encodes the RFC 5987 extra characters', () => {
    expect(attachmentContentDisposition("it's (1)*.txt")).toContain(
      "filename*=UTF-8''it%27s%20%281%29%2A.txt",
    );
  });
});

describe('resolveSignedUrlTtlSec', () => {
  it('uses the requested TTL, else the fallback', () => {
    expect(resolveSignedUrlTtlSec(60, 900)).toBe(60);
    expect(resolveSignedUrlTtlSec(undefined, 900)).toBe(900);
  });

  it('clamps to [1s, 7 days] and floors fractions', () => {
    expect(resolveSignedUrlTtlSec(0, 900)).toBe(1);
    expect(resolveSignedUrlTtlSec(-5, 900)).toBe(1);
    expect(resolveSignedUrlTtlSec(10.9, 900)).toBe(10);
    expect(resolveSignedUrlTtlSec(10 ** 9, 900)).toBe(MAX_SIGNED_URL_TTL_SEC);
  });
});

describe('unquoteEtag', () => {
  it('strips surrounding quotes', () => {
    expect(unquoteEtag('"abc"')).toBe('abc');
    expect(unquoteEtag('abc')).toBe('abc');
    expect(unquoteEtag(undefined)).toBeUndefined();
  });
});

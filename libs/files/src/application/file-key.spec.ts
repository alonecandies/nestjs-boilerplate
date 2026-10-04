import { DomainValidationException, generateId } from '@app/common';
import { describe, expect, it } from 'vitest';
import {
  buildUserFileKey,
  filenameOfFileKey,
  isFileKeyOwnedBy,
  isValidFileKey,
  userFilesPrefix,
} from './file-key.js';

describe('file keys', () => {
  const userId = generateId();

  it('builds users/{userId}/{uuidv7}-{safeFilename}', () => {
    const id = generateId();
    expect(buildUserFileKey(userId, 'Été 2026 — Photos (1).JPEG', id)).toBe(
      `users/${userId}/${id}-ete-2026-photos-1.jpeg`,
    );
  });

  it('mints a fresh uuidv7 per key and strips client paths from the filename', () => {
    const a = buildUserFileKey(userId, '../../etc/passwd');
    const b = buildUserFileKey(userId, '../../etc/passwd');
    expect(a).not.toBe(b);
    expect(a).toMatch(new RegExp(`^users/${userId}/[0-9a-f-]{36}-passwd$`));
  });

  it('rejects user ids that are not a single key segment', () => {
    expect(() => userFilesPrefix('a/b')).toThrow(DomainValidationException);
    expect(() => userFilesPrefix('')).toThrow(DomainValidationException);
    expect(userFilesPrefix(userId)).toBe(`users/${userId}`);
  });

  it('checks ownership by prefix, on a segment boundary', () => {
    const key = buildUserFileKey(userId, 'a.txt');
    expect(isFileKeyOwnedBy(key, userId)).toBe(true);
    expect(isFileKeyOwnedBy(key, generateId())).toBe(false);
    expect(isFileKeyOwnedBy(`users/${userId}0/x.txt`, userId)).toBe(false);
    expect(isFileKeyOwnedBy(`users/${userId}`, userId)).toBe(false);
    expect(isFileKeyOwnedBy(`other/${userId}/x.txt`, userId)).toBe(false);
  });

  it('validates keys like the storage layer does', () => {
    expect(isValidFileKey(`users/${userId}/a.txt`)).toBe(true);
    for (const bad of [
      '',
      '/users/a',
      'users//a',
      'users/a/../b',
      'users/a\\b',
      'users/a/\u0000',
    ]) {
      expect(isValidFileKey(bad)).toBe(false);
    }
  });

  it('recovers the human filename from a key', () => {
    const id = generateId();
    expect(filenameOfFileKey(`users/${userId}/${id}-report.pdf`)).toBe('report.pdf');
    expect(filenameOfFileKey(`users/${userId}/${id}-`)).toBe(`${id}-`);
    expect(filenameOfFileKey('users/u/legacy-name.txt')).toBe('legacy-name.txt');
    expect(filenameOfFileKey('plain.txt')).toBe('plain.txt');
  });
});

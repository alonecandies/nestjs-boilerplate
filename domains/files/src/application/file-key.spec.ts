import { DomainValidationException, generateId, PLATFORM_TENANT_ID } from '@platform/common';
import { describe, expect, it } from 'vitest';
import {
  buildUserFileKey,
  filenameOfFileKey,
  isFileKeyOwnedBy,
  isValidFileKey,
  tenantFilesPrefix,
  userFilesPrefix,
} from './file-key.js';

describe('file keys', () => {
  const tenantId = generateId();
  const userId = generateId();

  it('builds tenants/{tenantId}/users/{userId}/{uuidv7}/{safeFilename}', () => {
    const id = generateId();
    expect(buildUserFileKey(tenantId, userId, 'Été 2026 — Photos (1).JPEG', id)).toBe(
      `tenants/${tenantId}/users/${userId}/${id}/ete-2026-photos-1.jpeg`,
    );
  });

  it('mints a fresh uuidv7 per key and strips client paths from the filename', () => {
    const a = buildUserFileKey(tenantId, userId, '../../etc/passwd');
    const b = buildUserFileKey(tenantId, userId, '../../etc/passwd');
    expect(a).not.toBe(b);
    expect(a).toMatch(new RegExp(`^tenants/${tenantId}/users/${userId}/[0-9a-f-]{36}/passwd$`));
  });

  it('builds the tenant and user prefixes (no trailing slash)', () => {
    expect(tenantFilesPrefix(tenantId)).toBe(`tenants/${tenantId}`);
    expect(userFilesPrefix(tenantId, userId)).toBe(`tenants/${tenantId}/users/${userId}`);
  });

  it.each([
    ['an empty', ''],
    ['a slashed', `${tenantId}/x`],
    ['a non-UUID', 'acme'],
    ['the nil (platform)', PLATFORM_TENANT_ID],
  ])('throws for %s tenant', (_case, badTenant) => {
    expect(() => tenantFilesPrefix(badTenant)).toThrow(DomainValidationException);
    expect(() => userFilesPrefix(badTenant, userId)).toThrow(DomainValidationException);
    expect(() => buildUserFileKey(badTenant, userId, 'a.txt')).toThrow(DomainValidationException);
  });

  it('rejects user ids that are not a single key segment', () => {
    expect(() => userFilesPrefix(tenantId, 'a/b')).toThrow(DomainValidationException);
    expect(() => userFilesPrefix(tenantId, '')).toThrow(DomainValidationException);
    expect(() => buildUserFileKey(tenantId, 'a/b', 'a.txt')).toThrow(DomainValidationException);
  });

  it('checks ownership by tenant and user prefix, on a segment boundary', () => {
    const key = buildUserFileKey(tenantId, userId, 'a.txt');
    expect(isFileKeyOwnedBy(key, tenantId, userId)).toBe(true);
    expect(isFileKeyOwnedBy(key, tenantId, generateId())).toBe(false);
    expect(isFileKeyOwnedBy(key, generateId(), userId)).toBe(false);
    expect(isFileKeyOwnedBy(`tenants/${tenantId}/users/${userId}0/x.txt`, tenantId, userId)).toBe(
      false,
    );
    expect(isFileKeyOwnedBy(`tenants/${tenantId}/users/${userId}`, tenantId, userId)).toBe(false);
    expect(isFileKeyOwnedBy(`users/${userId}/x.txt`, tenantId, userId)).toBe(false);
  });

  it('validates keys like the storage layer does', () => {
    expect(isValidFileKey(`tenants/${tenantId}/users/${userId}/a.txt`)).toBe(true);
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

  it('takes the download filename from the last key segment', () => {
    const id = generateId();
    expect(filenameOfFileKey(buildUserFileKey(tenantId, userId, 'Report.PDF', id))).toBe(
      'report.pdf',
    );
    expect(filenameOfFileKey(`tenants/${tenantId}/users/${userId}/${id}/notes.txt`)).toBe(
      'notes.txt',
    );
    expect(filenameOfFileKey('plain.txt')).toBe('plain.txt');
  });
});

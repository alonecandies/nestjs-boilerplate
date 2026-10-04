import { makeAuthUser, Permission, Role } from '@app/auth';
import { DomainValidationException, generateId } from '@app/common';
import { describe, expect, it } from 'vitest';
import { resolveFileAccess } from './file-access.policy.js';

describe('resolveFileAccess', () => {
  const owner = makeAuthUser({ roles: [Role.User] });
  const other = makeAuthUser({ roles: [Role.Moderator] });
  const admin = makeAuthUser({ roles: [Role.Admin] });
  const key = `users/${owner.id}/${generateId()}-a.txt`;

  it('grants owners, then files:manage holders, and denies everyone else', () => {
    expect(resolveFileAccess(owner, key)).toBe('owner');
    expect(resolveFileAccess(admin, key)).toBe('manager');
    expect(resolveFileAccess(other, key)).toBe('denied');
    expect(resolveFileAccess({ id: other.id, permissions: [Permission.FilesManage] }, key)).toBe(
      'manager',
    );
  });

  it('validates the key before the prefix test (no traversal into another prefix)', () => {
    const traversal = `users/${owner.id}/../${other.id}/secret.txt`;
    expect(() => resolveFileAccess(owner, traversal)).toThrow(DomainValidationException);
    expect(() => resolveFileAccess(admin, '/absolute')).toThrow(DomainValidationException);
  });
});

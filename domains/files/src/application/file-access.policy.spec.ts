import { Role } from '@platform/auth';
import { createTestRbacRegistry, makeAuthUser } from '@platform/auth/testing';
import { DomainValidationException, generateId } from '@platform/common';
import { describe, expect, it } from 'vitest';
import { FILES_RBAC, FilesPermission } from '../files.permissions.js';
import { resolveFileAccess } from './file-access.policy.js';

describe('resolveFileAccess', () => {
  const rbac = createTestRbacRegistry(FILES_RBAC);
  const owner = makeAuthUser({ roles: [Role.User] }, rbac);
  const other = makeAuthUser({ roles: [Role.Moderator] }, rbac);
  const admin = makeAuthUser({ roles: [Role.Admin] }, rbac);
  const key = `users/${owner.id}/${generateId()}-a.txt`;

  it('grants owners, then files:manage holders, and denies everyone else', () => {
    expect(resolveFileAccess(owner, key)).toBe('owner');
    expect(resolveFileAccess(admin, key)).toBe('manager');
    expect(resolveFileAccess(other, key)).toBe('denied');
    expect(resolveFileAccess({ id: other.id, permissions: [FilesPermission.Manage] }, key)).toBe(
      'manager',
    );
  });

  it('validates the key before the prefix test (no traversal into another prefix)', () => {
    const traversal = `users/${owner.id}/../${other.id}/secret.txt`;
    expect(() => resolveFileAccess(owner, traversal)).toThrow(DomainValidationException);
    expect(() => resolveFileAccess(admin, '/absolute')).toThrow(DomainValidationException);
  });
});

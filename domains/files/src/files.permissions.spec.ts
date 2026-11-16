import { createTestRbacRegistry } from '@platform/auth/testing';
import { describe, expect, it } from 'vitest';
import { FILES_RBAC, FilesPermission } from './files.permissions.js';

describe('FILES_RBAC', () => {
  const rbac = createTestRbacRegistry(FILES_RBAC);

  it('declares every FilesPermission value', () => {
    expect(rbac.permissions()).toEqual(Object.values(FilesPermission).sort());
  });

  it('grants read and write to members', () => {
    expect(rbac.resolve(['member'])).toEqual([FilesPermission.Read, FilesPermission.Write].sort());
  });

  it('grants files:manage to admins until Task 10 withholds it (I-5)', () => {
    expect(rbac.resolve(['admin'])).toEqual(Object.values(FilesPermission).sort());
    expect(rbac.resolve(['owner'])).toEqual(Object.values(FilesPermission).sort());
  });
});

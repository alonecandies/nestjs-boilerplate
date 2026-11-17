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

  it('grants files:manage (any file of the active tenant) to admins, not to members', () => {
    expect(FILES_RBAC.grants.admin).toContain(FilesPermission.Manage);
    expect(FILES_RBAC.grants.member).not.toContain(FilesPermission.Manage);
    expect(rbac.resolve(['member'])).not.toContain(FilesPermission.Manage);
    for (const role of ['admin', 'owner'] as const) {
      expect(rbac.resolve([role])).toEqual(Object.values(FilesPermission).sort());
    }
  });
});

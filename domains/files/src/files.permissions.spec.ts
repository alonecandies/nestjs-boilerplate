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

  it('withholds files:manage from every role until B4-3 scopes storage keys to the tenant (I-5)', () => {
    for (const role of ['member', 'admin', 'owner'] as const) {
      expect(rbac.resolve([role])).toEqual([FilesPermission.Read, FilesPermission.Write].sort());
    }
  });
});

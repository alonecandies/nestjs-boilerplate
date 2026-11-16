import { createTestRbacRegistry } from '@platform/auth/testing';
import { describe, expect, it } from 'vitest';
import { IDENTITY_RBAC, IdentityPermission } from './identity.permissions.js';

describe('IDENTITY_RBAC', () => {
  const rbac = createTestRbacRegistry(IDENTITY_RBAC);

  it('declares every IdentityPermission value', () => {
    expect(rbac.permissions()).toEqual(Object.values(IdentityPermission).sort());
  });

  it('grants nothing to members', () => {
    expect(rbac.resolve(['member'])).toEqual([]);
  });

  it('grants user and member administration to admins (users:manage-roles goes in Task 11)', () => {
    expect(rbac.resolve(['admin'])).toEqual(
      [
        IdentityPermission.MembersManage,
        IdentityPermission.UsersManageRoles,
        IdentityPermission.UsersRead,
      ].sort(),
    );
  });

  it('adds tenant:manage for owners only', () => {
    expect(rbac.resolve(['owner'])).toEqual(Object.values(IdentityPermission).sort());
    expect(rbac.resolve(['admin'])).not.toContain(IdentityPermission.TenantManage);
  });
});

import { describe, expect, it } from 'vitest';
import { isPermission, PERMISSION_VALUES, Permission } from './permission.enum.js';
import { isRole, ROLE_VALUES, Role } from './role.enum.js';
import { hasPermissions, ROLE_PERMISSIONS, resolvePermissions } from './role-permissions.js';

describe('RBAC matrix (blueprint §5)', () => {
  it('grants admins everything', () => {
    expect(resolvePermissions([Role.Admin])).toEqual(PERMISSION_VALUES);
  });

  it('grants moderators user reads, notifications and file read/write only', () => {
    expect(resolvePermissions([Role.Moderator])).toEqual([
      Permission.UsersRead,
      Permission.NotificationsRead,
      Permission.NotificationsWrite,
      Permission.FilesRead,
      Permission.FilesWrite,
    ]);
  });

  it('grants users notifications:read, billing:checkout and file read/write', () => {
    const granted = resolvePermissions([Role.User]);
    expect(granted).toEqual([
      Permission.NotificationsRead,
      Permission.BillingCheckout,
      Permission.FilesRead,
      Permission.FilesWrite,
    ]);
    expect(granted).not.toContain(Permission.UsersRead); // self-access is an ownership rule
    expect(granted).not.toContain(Permission.FilesManage);
  });

  it('merges several roles without duplicates, in canonical order', () => {
    const merged = resolvePermissions([Role.User, Role.Moderator, Role.User]);
    expect(merged).toEqual([
      Permission.UsersRead,
      Permission.NotificationsRead,
      Permission.NotificationsWrite,
      Permission.BillingCheckout,
      Permission.FilesRead,
      Permission.FilesWrite,
    ]);
    expect(resolvePermissions([])).toEqual([]);
    expect(resolvePermissions(['ghost' as Role])).toEqual([]);
  });

  it('covers every role and is immutable', () => {
    expect(Object.keys(ROLE_PERMISSIONS).sort()).toEqual([...ROLE_VALUES].sort());
    expect(Object.isFrozen(ROLE_PERMISSIONS)).toBe(true);
    expect(Object.isFrozen(ROLE_PERMISSIONS[Role.User])).toBe(true);
  });
});

describe('hasPermissions', () => {
  const granted = [Permission.FilesRead, Permission.FilesWrite];

  it("'all' needs every permission, 'any' at least one", () => {
    expect(hasPermissions(granted, [Permission.FilesRead, Permission.FilesWrite])).toBe(true);
    expect(hasPermissions(granted, [Permission.FilesRead, Permission.FilesManage])).toBe(false);
    expect(hasPermissions(granted, [Permission.FilesRead, Permission.FilesManage], 'any')).toBe(
      true,
    );
    expect(hasPermissions(granted, [Permission.FilesManage, Permission.UsersRead], 'any')).toBe(
      false,
    );
  });

  it('an empty requirement is always satisfied', () => {
    expect(hasPermissions([], [])).toBe(true);
    expect(hasPermissions([], [], 'any')).toBe(true);
  });
});

describe('guards for untrusted values', () => {
  it('isRole / isPermission', () => {
    expect(isRole('admin')).toBe(true);
    expect(isRole('root')).toBe(false);
    expect(isRole(1)).toBe(false);
    expect(isPermission('files:read')).toBe(true);
    expect(isPermission('files:*')).toBe(false);
  });
});

import { isUuidV7 } from '@app/common';
import { describe, expect, it } from 'vitest';
import { Permission } from '../rbac/permission.enum.js';
import { Role } from '../rbac/role.enum.js';
import { isAuthUser } from '../tokens/token-claims.js';
import { makeAuthUser } from './auth-test.utils.js';

describe('makeAuthUser', () => {
  it('builds a valid regular user with a live token', () => {
    const user = makeAuthUser();
    expect(isAuthUser(user)).toBe(true);
    expect(isUuidV7(user.id)).toBe(true);
    expect(user.roles).toEqual([Role.User]);
    expect(user.permissions).toContain(Permission.BillingCheckout);
    expect(user.exp).toBeGreaterThan(Date.now() / 1_000);
  });

  it('resolves permissions from overridden roles unless given explicitly', () => {
    expect(makeAuthUser({ roles: [Role.Admin] }).permissions).toContain(Permission.FilesManage);
    expect(makeAuthUser({ roles: [Role.Admin], permissions: [] }).permissions).toEqual([]);
    expect(makeAuthUser({ id: 'fixed' }).id).toBe('fixed');
  });
});

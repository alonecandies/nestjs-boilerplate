import { isUuidV7 } from '@platform/common';
import { describe, expect, it } from 'vitest';
import { Role } from '../rbac/role.enum.js';
import { isAuthUser } from '../tokens/token-claims.js';
import { makeAuthUser } from './auth-test.utils.js';
import { createTestRbacRegistry, TEST_RBAC_FEATURE } from './rbac-test.utils.js';

describe('makeAuthUser', () => {
  it('builds a valid regular user with a live token', () => {
    const user = makeAuthUser();
    expect(isAuthUser(user)).toBe(true);
    expect(isUuidV7(user.id)).toBe(true);
    expect(user.roles).toEqual([Role.User]);
    expect(user.permissions).toEqual([]);
    expect(user.exp).toBeGreaterThan(Date.now() / 1_000);
  });

  it('resolves permissions from overridden roles unless given explicitly', () => {
    const rbac = createTestRbacRegistry(TEST_RBAC_FEATURE);
    expect(makeAuthUser({ roles: [Role.Admin] }, rbac).permissions).toContain('files:manage');
    expect(makeAuthUser({ roles: [Role.Admin], permissions: [] }).permissions).toEqual([]);
    expect(makeAuthUser({ id: 'fixed' }).id).toBe('fixed');
  });
});

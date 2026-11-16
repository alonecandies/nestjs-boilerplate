import { isUuidV7 } from '@platform/common';
import { describe, expect, it } from 'vitest';
import { isAuthUser } from '../tokens/token-claims.js';
import { makeAuthUser } from './auth-test.utils.js';
import { createTestRbacRegistry, TEST_RBAC_FEATURE } from './rbac-test.utils.js';
import { TEST_TENANT_ID } from './test-tenant.js';

describe('makeAuthUser', () => {
  it('builds a valid member of the test tenant with a live token', () => {
    const user = makeAuthUser();
    expect(isAuthUser(user)).toBe(true);
    expect(isUuidV7(user.id)).toBe(true);
    expect(user).toMatchObject({
      tenantId: TEST_TENANT_ID,
      roles: ['member'],
      staff: false,
      permissions: [],
    });
    expect(user.exp).toBeGreaterThan(Date.now() / 1_000);
  });

  it('resolves permissions from the roles through a registry unless given explicitly', () => {
    const rbac = createTestRbacRegistry(TEST_RBAC_FEATURE);
    expect(makeAuthUser({}, rbac).permissions).toContain('catalog:buy');
    expect(makeAuthUser({ roles: ['admin'] }, rbac).permissions).toContain('files:manage');
    expect(makeAuthUser({ roles: ['owner'] }, rbac).permissions).toContain('orders:approve');
    expect(makeAuthUser({ roles: ['admin'], permissions: [] }, rbac).permissions).toEqual([]);
    expect(makeAuthUser({ id: 'fixed' }).id).toBe('fixed');
  });
});

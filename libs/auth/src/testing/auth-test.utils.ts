import { generateId } from '@platform/common';
import type { RbacRegistry } from '../rbac/rbac.registry.js';
import type { AuthUser } from '../types/auth-user.js';
import { TEST_TENANT_ID } from './test-tenant.js';

/**
 * A valid `AuthUser` for tests: a member of `TEST_TENANT_ID`, token valid for 15 min. Permissions:
 * the given ones, else those `rbac` resolves for the roles (like production), else none.
 */
export function makeAuthUser(overrides: Partial<AuthUser> = {}, rbac?: RbacRegistry): AuthUser {
  const roles = overrides.roles ?? ['member'];
  return {
    id: generateId(),
    email: 'user@example.com',
    tenantId: TEST_TENANT_ID,
    staff: false,
    jti: generateId(),
    exp: Math.floor(Date.now() / 1_000) + 900,
    ...overrides,
    roles,
    permissions: overrides.permissions ?? rbac?.resolve(roles) ?? [],
  };
}

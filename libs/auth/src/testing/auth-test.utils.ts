import { generateId } from '@platform/common';
import { legacyTenantRoles } from '../rbac/legacy-tenant-roles.js';
import type { RbacRegistry } from '../rbac/rbac.registry.js';
import { Role } from '../rbac/role.enum.js';
import type { AuthUser } from '../types/auth-user.js';

/**
 * A valid `AuthUser` for tests (a regular user, token valid for 15 min). Permissions: the given
 * ones, else those `rbac` resolves for the roles (like production), else none.
 */
export function makeAuthUser(overrides: Partial<AuthUser> = {}, rbac?: RbacRegistry): AuthUser {
  const roles = overrides.roles ?? [Role.User];
  return {
    id: generateId(),
    email: 'user@example.com',
    jti: generateId(),
    exp: Math.floor(Date.now() / 1_000) + 900,
    ...overrides,
    roles,
    permissions: overrides.permissions ?? rbac?.resolve(legacyTenantRoles(roles)) ?? [],
  };
}

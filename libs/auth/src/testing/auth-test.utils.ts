import { generateId } from '@app/common';
import { Role } from '../rbac/role.enum.js';
import { resolvePermissions } from '../rbac/role-permissions.js';
import type { AuthUser } from '../types/auth-user.js';

/**
 * A valid `AuthUser` for tests (a regular user, token valid for 15 min). When `roles` is
 * overridden without `permissions`, permissions are resolved from the roles — like production.
 */
export function makeAuthUser(overrides: Partial<AuthUser> = {}): AuthUser {
  const roles = overrides.roles ?? [Role.User];
  return {
    id: generateId(),
    email: 'user@example.com',
    jti: generateId(),
    exp: Math.floor(Date.now() / 1_000) + 900,
    ...overrides,
    roles,
    permissions: overrides.permissions ?? resolvePermissions(roles),
  };
}

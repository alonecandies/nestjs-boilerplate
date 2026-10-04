import { flatMap } from 'lodash-es';
import { PERMISSION_VALUES, Permission } from './permission.enum.js';
import { Role } from './role.enum.js';

/** How several required permissions combine: every one of them, or at least one. */
export type PermissionMatchMode = 'all' | 'any';

/**
 * RBAC matrix (blueprint §5). "Self" access (a user reading their own profile) is NOT a
 * permission — it is an ownership rule enforced by the handler.
 */
export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = Object.freeze({
  [Role.Admin]: PERMISSION_VALUES,
  [Role.Moderator]: Object.freeze([
    Permission.UsersRead,
    Permission.NotificationsRead,
    Permission.NotificationsWrite,
    Permission.FilesRead,
    Permission.FilesWrite,
  ]),
  [Role.User]: Object.freeze([
    Permission.NotificationsRead,
    Permission.BillingCheckout,
    Permission.FilesRead,
    Permission.FilesWrite,
  ]),
});

/**
 * Union of the permissions granted by `roles`, deduplicated, in canonical (`Permission`
 * declaration) order. Unknown roles grant nothing. Resolved once per request by `toAuthUser`.
 */
export function resolvePermissions(roles: readonly Role[]): Permission[] {
  const granted = new Set<Permission>(flatMap(roles, (role) => ROLE_PERMISSIONS[role] ?? []));
  return PERMISSION_VALUES.filter((permission) => granted.has(permission));
}

/** `true` when `granted` satisfies `required` (`'all'` = every one, `'any'` = at least one). */
export function hasPermissions(
  granted: readonly Permission[],
  required: readonly Permission[],
  mode: PermissionMatchMode = 'all',
): boolean {
  if (required.length === 0) return true;
  const set = new Set(granted);
  return mode === 'all'
    ? required.every((permission) => set.has(permission))
    : required.some((permission) => set.has(permission));
}

import { normalizeTenantRoles, type TenantRole } from '@platform/common';
import { isRole, Role } from './role.enum.js';

const LEGACY: Readonly<Record<Role, TenantRole>> = Object.freeze({
  [Role.Admin]: 'admin',
  // Least privilege for the transition (I-3): `admin` would grant users:manage-roles.
  [Role.Moderator]: 'member',
  [Role.User]: 'member',
});

/** Global roles of a pre-tenancy token → tenant roles, for permission resolution only (until Task 10). */
export function legacyTenantRoles(roles: readonly unknown[]): TenantRole[] {
  return normalizeTenantRoles(roles.filter(isRole).map((role) => LEGACY[role]));
}

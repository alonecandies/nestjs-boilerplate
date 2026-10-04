import { type CustomDecorator, SetMetadata } from '@nestjs/common';
import { PERMISSIONS_KEY } from '../auth.constants.js';
import type { Permission } from '../rbac/permission.enum.js';
import type { PermissionMatchMode } from '../rbac/role-permissions.js';

/** Metadata stored under `PERMISSIONS_KEY` (read by `PermissionsGuard`). */
export interface PermissionRequirement {
  readonly permissions: readonly Permission[];
  readonly mode: PermissionMatchMode;
}

const requirement = (
  permissions: readonly Permission[],
  mode: PermissionMatchMode,
): PermissionRequirement => Object.freeze({ permissions: Object.freeze([...permissions]), mode });

/** Requires EVERY listed permission. Handler-level metadata overrides class-level metadata. */
export const RequirePermissions = (...permissions: Permission[]): CustomDecorator<string> =>
  SetMetadata(PERMISSIONS_KEY, requirement(permissions, 'all'));

/** Requires AT LEAST ONE of the listed permissions. */
export const RequireAnyPermission = (...permissions: Permission[]): CustomDecorator<string> =>
  SetMetadata(PERMISSIONS_KEY, requirement(permissions, 'any'));

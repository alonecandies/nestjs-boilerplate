import { type CustomDecorator, SetMetadata } from '@nestjs/common';
import { PERMISSIONS_KEY } from '../auth.constants.js';
import type { PermissionMatchMode } from '../rbac/permission-match.js';

/** Metadata stored under `PERMISSIONS_KEY` (read by `PermissionsGuard`). */
export interface PermissionRequirement {
  readonly permissions: readonly string[];
  readonly mode: PermissionMatchMode;
}

const requirement = (
  permissions: readonly string[],
  mode: PermissionMatchMode,
): PermissionRequirement => Object.freeze({ permissions: Object.freeze([...permissions]), mode });

/** Requires EVERY listed permission. Handler-level metadata overrides class-level metadata. */
export const RequirePermissions = (...permissions: string[]): CustomDecorator<string> =>
  SetMetadata(PERMISSIONS_KEY, requirement(permissions, 'all'));

/** Requires AT LEAST ONE of the listed permissions. */
export const RequireAnyPermission = (...permissions: string[]): CustomDecorator<string> =>
  SetMetadata(PERMISSIONS_KEY, requirement(permissions, 'any'));

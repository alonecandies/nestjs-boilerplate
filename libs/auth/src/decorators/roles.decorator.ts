import { type CustomDecorator, SetMetadata } from '@nestjs/common';
import { ROLES_KEY } from '../auth.constants.js';
import type { Role } from '../rbac/role.enum.js';

/**
 * Requires ANY of `roles` (checked by `RolesGuard`; a handler-level decorator overrides the
 * class-level one). Prefer `@RequirePermissions` — roles are coarse and change more often.
 */
export const Roles = (...roles: Role[]): CustomDecorator<string> =>
  SetMetadata(ROLES_KEY, Object.freeze([...roles]));

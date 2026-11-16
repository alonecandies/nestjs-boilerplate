import { type CustomDecorator, SetMetadata } from '@nestjs/common';
import type { TenantRole } from '@platform/common';
import { ROLES_KEY } from '../auth.constants.js';

/**
 * Requires ANY of `roles` (checked by `RolesGuard`; a handler-level decorator overrides the
 * class-level one). Prefer `@RequirePermissions` — roles are coarse and change more often.
 */
export const Roles = (...roles: TenantRole[]): CustomDecorator<string> =>
  SetMetadata(ROLES_KEY, Object.freeze([...roles]));

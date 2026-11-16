import { type CustomDecorator, SetMetadata } from '@nestjs/common';
import type { TenantRole } from '@platform/common';
import { ROLES_KEY } from '../auth.constants.js';

/**
 * Requires ANY of `roles` in the active tenant, with the hierarchy owner ⊇ admin ⊇ member
 * (`@Roles('admin')` admits owners). Use it only when the role itself is the requirement (spec §6:
 * owner-only operations); otherwise declare a permission and use `@RequirePermissions`.
 */
export const Roles = (...roles: TenantRole[]): CustomDecorator<string> =>
  SetMetadata(ROLES_KEY, Object.freeze([...roles]));

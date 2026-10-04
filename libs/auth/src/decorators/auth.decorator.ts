import type { CustomDecorator } from '@nestjs/common';
import type { Permission } from '../rbac/permission.enum.js';
import { RequirePermissions } from './require-permissions.decorator.js';

/**
 * Marks an authenticated endpoint that needs `permissions` (all of them). Authentication itself is
 * global (`JwtAuthGuard`), so this only adds the permission requirement. `@nestjs/swagger` is not a
 * dependency of @app/auth: add `@ApiBearerAuth()` in the presentation layer.
 */
export const Auth = (...permissions: Permission[]): CustomDecorator<string> =>
  RequirePermissions(...permissions);

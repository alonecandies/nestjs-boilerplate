import type { CustomDecorator } from '@nestjs/common';
import { RequirePermissions } from './require-permissions.decorator.js';

/**
 * Marks an authenticated endpoint that needs `permissions` (all of them). Authentication itself is
 * global (`JwtAuthGuard`), so this only adds the permission requirement. `@nestjs/swagger` is not a
 * dependency of @platform/auth: add `@ApiBearerAuth()` in the presentation layer.
 */
export const Auth = (...permissions: string[]): CustomDecorator<string> =>
  RequirePermissions(...permissions);

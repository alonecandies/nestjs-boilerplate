import { getContextType, PermissionDeniedException } from '@app/common';
import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from '../auth.constants.js';
import type { PermissionRequirement } from '../decorators/require-permissions.decorator.js';
import { hasPermissions } from '../rbac/role-permissions.js';
import { requireAuthUser } from './current-auth-user.js';

/**
 * `@RequirePermissions` (all) / `@RequireAnyPermission` (any) enforcement against
 * `req.user.permissions` (resolved from roles at token verification). No metadata → pass; rpc → pass.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (getContextType(context) === 'rpc') return true;
    const requirement = this.reflector.getAllAndOverride<PermissionRequirement | undefined>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!requirement || requirement.permissions.length === 0) return true;
    const user = requireAuthUser(context);
    if (hasPermissions(user.permissions, requirement.permissions, requirement.mode)) return true;
    throw new PermissionDeniedException('Insufficient permissions', {
      details: { requiredPermissions: [...requirement.permissions], mode: requirement.mode },
    });
  }
}

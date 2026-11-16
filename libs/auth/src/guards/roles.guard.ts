import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  getContextType,
  PermissionDeniedException,
  satisfiesTenantRole,
  type TenantRole,
} from '@platform/common';
import { isEmpty } from 'lodash-es';
import { ROLES_KEY } from '../auth.constants.js';
import { requireAuthUser } from './current-auth-user.js';

/** `@Roles(...)` enforcement: ANY listed tenant role (hierarchy applied) grants access; no metadata → pass; rpc → pass. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (getContextType(context) === 'rpc') return true;
    const required = this.reflector.getAllAndOverride<readonly TenantRole[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required || isEmpty(required)) return true;
    const user = requireAuthUser(context);
    if (required.some((role) => satisfiesTenantRole(user.roles, role))) return true;
    throw new PermissionDeniedException('Insufficient role', {
      details: { requiredRoles: [...required] },
    });
  }
}

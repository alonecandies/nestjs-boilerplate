import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { getContextType, PermissionDeniedException } from '@platform/common';
import { RbacErrorCode } from '../auth.constants.js';
import { requireAuthUser } from './current-auth-user.js';

/**
 * `@StaffOnly()` enforcement: only a platform-staff switch-in token (`staff: true`, B2-11) passes.
 * An owner is not staff. rpc handlers pass (services trust the edge).
 */
@Injectable()
export class StaffOnlyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (getContextType(context) === 'rpc') return true;
    if (requireAuthUser(context).staff === true) return true;
    throw new PermissionDeniedException('Platform staff only', { code: RbacErrorCode.STAFF_ONLY });
  }
}

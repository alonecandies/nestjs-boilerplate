import { type AuthUser } from '@platform/auth';
import { PermissionDeniedException } from '@platform/common';
import { IdentityPermission } from '../../identity.permissions.js';

/**
 * RBAC matrix §5: `users:read` holders read any profile; everyone else only their own. Checked
 * BEFORE the cache lookup, so the cache can never serve someone else's profile.
 */
export function assertCanReadUser(actor: AuthUser, userId: string): void {
  if (actor.id === userId || actor.permissions.includes(IdentityPermission.UsersRead)) return;
  throw new PermissionDeniedException('You can only read your own profile', {
    details: { requiredPermissions: [IdentityPermission.UsersRead] },
  });
}

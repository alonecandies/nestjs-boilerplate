import { type AuthUser, Permission } from '@app/auth';
import { PermissionDeniedException } from '@app/common';

/**
 * RBAC matrix §5: `users:read` holders read any profile; everyone else only their own. Checked
 * BEFORE the cache lookup, so the cache can never serve someone else's profile.
 */
export function assertCanReadUser(actor: AuthUser, userId: string): void {
  if (actor.id === userId || actor.permissions.includes(Permission.UsersRead)) return;
  throw new PermissionDeniedException('You can only read your own profile', {
    details: { requiredPermissions: [Permission.UsersRead] },
  });
}

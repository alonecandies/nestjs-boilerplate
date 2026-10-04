import { type AuthUser, hasPermissions, Permission } from '@app/auth';
import { PermissionDeniedException } from '@app/common';

/**
 * Whose payments a listing returns: the caller's own, or — with `all` — everyone's, which needs
 * `billing:read-all`. Shared by REST and GraphQL. The permission depends on an argument value, so
 * it cannot be a static `@RequirePermissions()`.
 *
 * @returns the owner filter (`undefined` = all users)
 * @throws PermissionDeniedException `all` without `billing:read-all` (403)
 */
export function resolvePaymentsOwner(user: AuthUser, all: boolean): string | undefined {
  if (!all) return user.id;
  if (!hasPermissions(user.permissions, [Permission.BillingReadAll])) {
    throw new PermissionDeniedException('Listing all payments requires billing:read-all', {
      details: { required: [Permission.BillingReadAll] },
    });
  }
  return undefined;
}

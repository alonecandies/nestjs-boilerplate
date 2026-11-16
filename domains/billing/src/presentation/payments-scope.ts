import { type AuthUser, hasPermissions } from '@platform/auth';
import { PermissionDeniedException } from '@platform/common';
import { BillingPermission } from '../billing.permissions.js';

/**
 * Whose payments a listing returns: the caller's own, or — with `all` — every payment of the
 * caller's active tenant (never another tenant's), which needs `billing:read-all`. Shared by REST and GraphQL. The permission depends on an argument value, so
 * it cannot be a static `@RequirePermissions()`.
 *
 * @returns the owner filter (`undefined` = every user of the active tenant)
 * @throws PermissionDeniedException `all` without `billing:read-all` (403)
 */
export function resolvePaymentsOwner(user: AuthUser, all: boolean): string | undefined {
  if (!all) return user.id;
  if (!hasPermissions(user.permissions, [BillingPermission.ReadAll])) {
    throw new PermissionDeniedException(
      'Listing every payment of this workspace requires billing:read-all',
      {
        details: { required: [BillingPermission.ReadAll] },
      },
    );
  }
  return undefined;
}

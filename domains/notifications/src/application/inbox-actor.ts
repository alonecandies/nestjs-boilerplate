import { type Principal, requirePrincipal } from '@platform/common';
import { InboxTenantMismatchException } from '../domain/notification.errors.js';

/**
 * The one inbox access check for both topologies (`ListNotificationsHandler`,
 * `MarkNotificationReadHandler`): the principal the edge put in CLS (JwtAuthGuard /
 * PrincipalContextInterceptor in the monolith and gateway, GrpcContextInterceptor in
 * notifications-service) must be exactly this tenant and this user. The request's tenant is only
 * compared, never used as the source. A staff switch-in principal passes only for its own pair.
 *
 * @throws UnauthenticatedException PRINCIPAL_MISSING (401) outside an authenticated call
 * @throws InboxTenantMismatchException TENANT_MISMATCH (403)
 */
export function requireInboxActor(tenantId: string, userId: string): Principal {
  const principal = requirePrincipal();
  if (
    principal.tenantId === null ||
    principal.tenantId !== tenantId ||
    principal.userId !== userId
  ) {
    throw new InboxTenantMismatchException();
  }
  return principal;
}

import { type Principal, requirePrincipal } from '@platform/common';
import { TenantMismatchException } from '../domain/billing.errors.js';

/**
 * Billing is tenant-scoped: the request's tenant (and user, when given) must be the principal's,
 * which the edge put in CLS (JwtAuthGuard in the monolith, GrpcContextInterceptor in
 * billing-service). Defence in depth: the edge already copies both from `req.user`.
 *
 * @throws UnauthenticatedException PRINCIPAL_MISSING (401) outside an authenticated call
 * @throws TenantMismatchException (403)
 */
export function requireTenantPrincipal(tenantId: string, userId?: string): Principal {
  const principal = requirePrincipal();
  if (principal.tenantId !== tenantId || (userId !== undefined && principal.userId !== userId)) {
    throw new TenantMismatchException();
  }
  return principal;
}

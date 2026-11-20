import { type Principal, requirePrincipal } from '@platform/common';
import { AiTenantMismatchException } from '../domain/ai.errors.js';

/** Who a request acts for: always the edge's principal (`req.user`), never request input. */
export interface AiCaller {
  readonly tenantId: string;
  readonly userId: string;
}

/**
 * The request's tenant and user must be the CLS principal's (JwtAuthGuard in the monolith, the gRPC
 * context interceptor in a service). Defence in depth: the edge already copies both from the token.
 *
 * @throws UnauthenticatedException PRINCIPAL_MISSING (401) outside an authenticated call
 * @throws AiTenantMismatchException (403)
 */
export function requireCaller(caller: AiCaller): Principal {
  const principal = requirePrincipal();
  if (principal.tenantId !== caller.tenantId || principal.userId !== caller.userId) {
    throw new AiTenantMismatchException();
  }
  return principal;
}

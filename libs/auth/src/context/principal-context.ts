import {
  createPrincipal,
  getPrincipal,
  type Principal,
  setPrincipal,
  TenancyErrorCode,
  UnauthenticatedException,
} from '@platform/common';
import { ClsServiceManager } from 'nestjs-cls';
import type { AuthUser } from '../types/auth-user.js';

/** The request principal (spec §7) of an authenticated `AuthUser`. @throws 401 INVALID_PRINCIPAL */
export function principalOf(user: AuthUser): Principal {
  return createPrincipal({
    userId: user.id,
    tenantId: user.tenantId,
    roles: user.roles,
    staff: user.staff,
  });
}

/**
 * Edge writer of `CLS_PRINCIPAL` (I-2): only inside an active CLS context (never opens one: that
 * would hide the request id), and never over a principal of ANOTHER user: that throws (fail closed),
 * since `req.user` and the principal must name the same user. The same user may move tenant
 * (switch-tenant re-authenticates the request with the new token's tenant).
 * @throws UnauthenticatedException INVALID_PRINCIPAL (another user's principal, or an invalid one)
 */
export function writePrincipal(user: AuthUser): void {
  if (!ClsServiceManager.getClsService().isActive()) return;
  const current = getPrincipal();
  if (current !== undefined && current.userId !== user.id) {
    throw new UnauthenticatedException('Principal mismatch', {
      code: TenancyErrorCode.INVALID_PRINCIPAL,
      details: { reason: 'principal mismatch' },
    });
  }
  setPrincipal(principalOf(user));
}

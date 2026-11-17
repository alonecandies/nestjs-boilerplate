import { type Principal, requirePrincipal, type TenantRole } from '@platform/common';
import { TenantAccessDeniedException } from '../../domain/identity.errors.js';
import type { MembershipsRepository } from '../persistence/memberships.repository.js';

/**
 * The request's principal, which must be acting in `tenantId` as `actorId` (both copied from the
 * access token by the edge; this cross-checks the CLS principal of JwtAuthGuard or
 * GrpcContextInterceptor). One error for every mismatch, as for login and switch.
 */
export function requireTenantActor(tenantId: string, actorId: string): Principal {
  const principal = requirePrincipal();
  if (principal.tenantId !== tenantId || principal.userId !== actorId) {
    throw new TenantAccessDeniedException();
  }
  return principal;
}

/**
 * The request's principal must be acting in `tenantId`: the assertion in front of a system read
 * scoped to that tenant (the row-local policies cannot check it; ruling `b3-identity-policies`).
 */
export function requireActingIn(tenantId: string): Principal {
  const principal = requirePrincipal();
  if (principal.tenantId !== tenantId) throw new TenantAccessDeniedException();
  return principal;
}

/**
 * User-scoped calls (my tenants, create a tenant): the request's user must be the principal. The
 * gateway copies both from the same token; identity-service trusts no request user id on its own.
 */
export function requireSelf(userId: string): Principal {
  const principal = requirePrincipal();
  if (principal.userId !== userId) throw new TenantAccessDeniedException();
  return principal;
}

/**
 * The actor's roles in its tenant. The membership row is authoritative (an access token keeps the
 * roles it was issued with for its whole TTL); a staff switch-in principal has no membership and acts
 * with the token's `admin` role (spec §5.2).
 */
export async function actorTenantRoles(
  principal: Principal,
  memberships: MembershipsRepository,
): Promise<TenantRole[]> {
  if (principal.tenantId === null) throw new TenantAccessDeniedException();
  if (principal.staff) return [...principal.roles];
  const membership = await memberships.find(principal.tenantId, principal.userId);
  if (membership === null) throw new TenantAccessDeniedException();
  return [...membership.roles];
}

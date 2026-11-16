import { UnauthenticatedException } from '../errors/domain.exception.js';
import { isUuid } from '../utils/id.util.js';
import { isPlatformTenantId } from './platform-tenant.js';
import { normalizeTenantRoles, type TenantRole } from './tenant-role.js';

/** Who a unit of work runs as (spec §7). Written into CLS at every edge. */
export interface Principal {
  readonly userId: string;
  /** null only in user-scoped units of work (login before the tenant is chosen). */
  readonly tenantId: string | null;
  /** Roles in `tenantId`; always [] when tenantId is null. */
  readonly roles: readonly TenantRole[];
  /** true only for a staff switch-in token (always with a tenant). */
  readonly staff: boolean;
}

export interface PrincipalInput {
  readonly userId: string;
  readonly tenantId: string | null;
  readonly roles?: readonly unknown[];
  readonly staff?: boolean;
}

export const TenancyErrorCode = {
  INVALID_PRINCIPAL: 'INVALID_PRINCIPAL',
  PRINCIPAL_MISSING: 'PRINCIPAL_MISSING',
} as const;
export type TenancyErrorCode = (typeof TenancyErrorCode)[keyof typeof TenancyErrorCode];

const invalid = (reason: string): UnauthenticatedException =>
  new UnauthenticatedException('Invalid principal', {
    code: TenancyErrorCode.INVALID_PRINCIPAL,
    details: { reason },
  });

/**
 * The only way to build a principal. B3's transaction adapter writes these values into `SET LOCAL`
 * strings, so ids must be UUIDs and the platform tenant is refused here, once.
 */
export function createPrincipal(input: PrincipalInput): Principal {
  if (!isUuid(input.userId) || isPlatformTenantId(input.userId))
    throw invalid('userId is not a UUID');
  const { tenantId } = input;
  if (tenantId !== null) {
    if (!isUuid(tenantId)) throw invalid('tenantId is not a UUID');
    if (isPlatformTenantId(tenantId)) throw invalid('tenantId is the platform tenant');
  }
  const roles = normalizeTenantRoles(input.roles ?? []);
  const staff = input.staff === true;
  if (tenantId === null && (roles.length > 0 || staff))
    throw invalid('roles and staff need a tenant');
  return Object.freeze({ userId: input.userId, tenantId, roles: Object.freeze(roles), staff });
}

/** True only for a value `createPrincipal` could have returned (same id, tenant and role rules). */
export function isPrincipal(value: unknown): value is Principal {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const { roles, staff, tenantId, userId } = candidate;
  if (!isUuid(userId) || isPlatformTenantId(userId) || typeof staff !== 'boolean') return false;
  if (!Array.isArray(roles)) return false;
  const normalized = normalizeTenantRoles(roles);
  // Canonical order and no unknown or duplicate value: exactly what createPrincipal stores.
  if (normalized.length !== roles.length || normalized.some((role, i) => role !== roles[i]))
    return false;
  if (tenantId === null) return roles.length === 0 && !staff;
  return isUuid(tenantId) && !isPlatformTenantId(tenantId);
}

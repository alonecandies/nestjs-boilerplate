import type { MyTenant, Tenant } from '@domain/identity-contracts';
import { DomainValidationException } from '@platform/common';
import { IDENTITY_LIMITS } from '../../identity.constants.js';
import type { TenantMembership } from '../persistence/memberships.repository.js';
import type { TenantRecord } from '../persistence/tenants.repository.js';

export function toTenantContract(tenant: TenantRecord): Tenant {
  return {
    id: tenant.id,
    slug: tenant.slug,
    name: tenant.name,
    personal: tenant.personal,
    createdAt: tenant.createdAt,
  };
}

export function toMyTenantContract(membership: TenantMembership): MyTenant {
  return {
    tenant: toTenantContract(membership.tenant),
    roles: [...membership.roles],
    ...(membership.lastActiveAt === null ? {} : { lastActiveAt: membership.lastActiveAt }),
  };
}

/** Trimmed tenant name, 1..TENANT_NAME_MAX_LENGTH characters (code points). */
export function normalizeTenantName(name: string): string {
  const trimmed = name.trim();
  const length = [...trimmed].length;
  if (length === 0 || length > IDENTITY_LIMITS.TENANT_NAME_MAX_LENGTH) {
    throw new DomainValidationException('Invalid tenant name', {
      issues: [
        { path: 'name', message: `Must be 1-${IDENTITY_LIMITS.TENANT_NAME_MAX_LENGTH} characters` },
      ],
    });
  }
  return trimmed;
}

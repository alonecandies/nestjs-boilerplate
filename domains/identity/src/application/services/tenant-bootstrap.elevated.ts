import { Injectable } from '@nestjs/common';
import { requirePrincipal } from '@platform/common';
import { RlsElevation } from '@platform/database';
import { TenantAccessDeniedException } from '../../domain/identity.errors.js';
import { MembershipsRepository } from '../persistence/memberships.repository.js';
import { type NewTenant, TenantsRepository } from '../persistence/tenants.repository.js';

/**
 * A new tenant and its owner membership (spec §9, justified reason `tenant-bootstrap`): register,
 * login of an account without a membership, `POST /v1/tenants`. The unit of work already runs as
 * `{ owner, newTenant, ['owner'] }` (the ids were generated before BEGIN); the tenant row passes its
 * own policy, and only the owner membership insert needs the elevation, scoped to that statement.
 * Runs in the caller's unit of work.
 * @throws TenantAccessDeniedException when the principal is not that owner in that tenant
 */
@Injectable()
export class TenantBootstrap {
  constructor(
    private readonly tenants: TenantsRepository,
    private readonly memberships: MembershipsRepository,
    private readonly elevation: RlsElevation,
  ) {}

  async create(tenant: NewTenant, ownerId: string, lastActiveAt: Date | null): Promise<void> {
    const principal = requirePrincipal();
    if (
      principal.userId !== ownerId ||
      principal.tenantId !== tenant.id ||
      principal.staff ||
      !principal.roles.includes('owner')
    ) {
      throw new TenantAccessDeniedException();
    }
    await this.tenants.insert(tenant);
    await this.elevation.justified('tenant-bootstrap', () =>
      this.memberships.insert({
        tenantId: tenant.id,
        userId: ownerId,
        roles: ['owner'],
        lastActiveAt,
      }),
    );
  }
}

import { Injectable } from '@nestjs/common';
import { requirePrincipal } from '@platform/common';
import { RlsElevation } from '@platform/database';
import { TenantAccessDeniedException } from '../../domain/identity.errors.js';
import { MembershipsRepository } from '../persistence/memberships.repository.js';

/**
 * `memberships.last_active_at` of the session's own membership (plan ruling 1, justified reason
 * `membership-activity`): login and switch-tenant touch it in the unit of work that opens the
 * session, as `{ user, tenant, roles }`. The memberships update policy needs elevation; the scope is
 * the one UPDATE of the principal's own row.
 * @throws TenantAccessDeniedException when the row is not the principal's own membership
 * @throws RowCountMismatchError when the membership is gone
 */
@Injectable()
export class MembershipActivity {
  constructor(
    private readonly memberships: MembershipsRepository,
    private readonly elevation: RlsElevation,
  ) {}

  async touch(tenantId: string, userId: string, at: Date): Promise<void> {
    const principal = requirePrincipal();
    if (principal.userId !== userId || principal.tenantId !== tenantId || principal.staff) {
      throw new TenantAccessDeniedException();
    }
    await this.elevation.justified('membership-activity', () =>
      this.memberships.touch(tenantId, userId, at),
    );
  }
}

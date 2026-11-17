import { Injectable } from '@nestjs/common';
import { requirePrincipal } from '@platform/common';
import { RlsElevation, RowCountMismatchError } from '@platform/database';
import { TenantAccessDeniedException } from '../../domain/identity.errors.js';
import { MembershipsRepository } from '../persistence/memberships.repository.js';

/**
 * `memberships.last_active_at` of the session's own membership (plan ruling 1, justified reason
 * `membership-activity`): login and switch-tenant touch it in the unit of work that opens the
 * session, as `{ user, tenant, roles }`. The memberships update policy needs elevation; the scope is
 * the one UPDATE of the principal's own row.
 * @throws TenantAccessDeniedException when the row is not the principal's own membership, or when
 *   the membership is gone: removed between the caller's read (TenantSelection, switch-tenant) and
 *   this UPDATE, which then matches no row. A 403 like "not a member", never a row-count 500.
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
    try {
      await this.elevation.justified('membership-activity', () =>
        this.memberships.touch(tenantId, userId, at),
      );
    } catch (error) {
      // The UPDATE matched no row: the membership was removed since it was read. The unit of work
      // rolls back on the throw, so no session opens in a tenant the user has left.
      if (error instanceof RowCountMismatchError)
        throw new TenantAccessDeniedException({ cause: error });
      throw error;
    }
  }
}

import { Injectable } from '@nestjs/common';
import { isPlatformTenantId, isUuid } from '@platform/common';
import { TenantAccessDeniedException } from '../../domain/identity.errors.js';
import {
  type MembershipRecord,
  MembershipsRepository,
} from '../persistence/memberships.repository.js';
import type { UserRecord } from '../persistence/users.repository.js';

/**
 * Which membership a login opens its session in (spec §5.2). Reads only: it runs as
 * `{ user, null }` (the memberships policy shows the user's own rows in every tenant); the login
 * then touches the chosen membership, or bootstraps a workspace, as the chosen tenant.
 */
@Injectable()
export class TenantSelection {
  constructor(private readonly memberships: MembershipsRepository) {}

  /**
   * `tenantId` given: that membership, else 403 (also for unknown, malformed and platform ids).
   * Absent: the most recently active membership, or null for an account without any (created
   * before B2), which then gets its personal workspace.
   * @throws TenantAccessDeniedException
   */
  async forLogin(user: UserRecord, tenantId: string | undefined): Promise<MembershipRecord | null> {
    if (tenantId === undefined) return this.memberships.findMostRecentForUser(user.id);
    const membership =
      isUuid(tenantId) && !isPlatformTenantId(tenantId)
        ? await this.memberships.find(tenantId, user.id)
        : null;
    if (membership === null) throw new TenantAccessDeniedException();
    return membership;
  }
}

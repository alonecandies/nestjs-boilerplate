import { Injectable } from '@nestjs/common';
import { isPlatformTenantId, isUuid } from '@platform/common';
import { TenantAccessDeniedException } from '../../domain/identity.errors.js';
import {
  type MembershipRecord,
  MembershipsRepository,
} from '../persistence/memberships.repository.js';
import type { UserRecord } from '../persistence/users.repository.js';
import { PersonalWorkspaces } from './personal-workspaces.service.js';

/** Which tenant a login opens its session in (spec §5.2). Runs in the login's unit of work. */
@Injectable()
export class TenantSelection {
  constructor(
    private readonly memberships: MembershipsRepository,
    private readonly workspaces: PersonalWorkspaces,
  ) {}

  /**
   * `tenantId` given: that membership, else 403 (also for unknown, malformed and platform ids).
   * Absent: the most recently active membership; an account without any (created before B2) gets its
   * personal workspace. The chosen membership's `last_active_at` becomes `now`.
   * @throws TenantAccessDeniedException
   */
  async forLogin(
    user: UserRecord,
    tenantId: string | undefined,
    now: Date,
  ): Promise<MembershipRecord> {
    let membership: MembershipRecord | null;
    if (tenantId !== undefined) {
      membership =
        isUuid(tenantId) && !isPlatformTenantId(tenantId)
          ? await this.memberships.find(tenantId, user.id)
          : null;
      if (membership === null) throw new TenantAccessDeniedException();
    } else {
      membership = await this.memberships.findMostRecentForUser(user.id);
      if (membership === null) return this.workspaces.create(user, now);
    }
    await this.memberships.touch(membership.tenantId, user.id, now);
    return { ...membership, lastActiveAt: now };
  }
}

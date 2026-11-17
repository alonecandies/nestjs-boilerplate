import { Injectable } from '@nestjs/common';
import { generateId } from '@platform/common';
import { deriveTenantSlug, personalWorkspaceName } from '../../domain/tenant-slug.js';
import {
  type MembershipRecord,
  MembershipsRepository,
} from '../persistence/memberships.repository.js';
import { TenantsRepository } from '../persistence/tenants.repository.js';

/**
 * The personal workspace every account gets (spec §5.2): a `personal` tenant named
 * `"<display name>'s workspace"`, slugged from the email's local part, and an owner membership marked
 * active now. Runs in the caller's unit of work (register; login of a pre-tenancy account), so it
 * publishes nothing: the caller publishes `MembershipCreatedEvent` once that unit of work committed.
 */
@Injectable()
export class PersonalWorkspaces {
  constructor(
    private readonly tenants: TenantsRepository,
    private readonly memberships: MembershipsRepository,
  ) {}

  /** `tenantId`: the workspace id when the caller needs it up front (register); default a new uuidv7. */
  async create(
    user: { id: string; email: string; displayName: string },
    now: Date,
    tenantId: string = generateId(),
  ): Promise<MembershipRecord> {
    const localPart = user.email.split('@')[0] ?? '';
    await this.tenants.insert({
      id: tenantId,
      slug: deriveTenantSlug(localPart, tenantId),
      name: personalWorkspaceName(user.displayName),
      personal: true,
    });
    await this.memberships.insert({
      tenantId,
      userId: user.id,
      roles: ['owner'],
      lastActiveAt: now,
    });
    return { tenantId, userId: user.id, roles: ['owner'], lastActiveAt: now, createdAt: now };
  }
}

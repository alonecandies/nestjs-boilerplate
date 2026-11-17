import { Injectable } from '@nestjs/common';
import { generateId } from '@platform/common';
import { deriveTenantSlug, personalWorkspaceName } from '../../domain/tenant-slug.js';
import type { NewTenant } from '../persistence/tenants.repository.js';

/**
 * The personal workspace every account gets (spec §5.2): a `personal` tenant named
 * `"<display name>'s workspace"`, slugged from the email's local part. `plan` only builds the row,
 * with its id generated here, BEFORE the unit of work opens: that unit runs as
 * `{ user, workspace.id, ['owner'] }`, and `TenantBootstrap.create` writes the tenant and the owner
 * membership (register; login of an account without a membership). The caller publishes
 * `MembershipCreatedEvent` once that unit of work committed.
 */
@Injectable()
export class PersonalWorkspaces {
  /** `id`: the workspace id when the caller needs it up front (register); default a new uuidv7. */
  plan(user: { email: string; displayName: string }, id: string = generateId()): NewTenant {
    const localPart = user.email.split('@')[0] ?? '';
    return {
      id,
      slug: deriveTenantSlug(localPart, id),
      name: personalWorkspaceName(user.displayName),
      personal: true,
    };
  }
}

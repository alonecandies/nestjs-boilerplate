import { Injectable } from '@nestjs/common';
import { requirePrincipal } from '@platform/common';
import { RlsElevation } from '@platform/database';
import {
  InvitationInvalidException,
  MembershipAlreadyExistsException,
  TenantAccessDeniedException,
} from '../../domain/identity.errors.js';
import { AUDIT_EVENT_TYPES } from '../persistence/audit-events.repository.js';
import type { InvitationRecord } from '../persistence/invitations.repository.js';
import { InvitationsRepository } from '../persistence/invitations.repository.js';
import { MembershipsRepository } from '../persistence/memberships.repository.js';
import { TenantAuditLog } from './tenant-audit-log.service.js';

/**
 * The writes of an accepted invitation (spec §9, justified reason `verified-invitation`): mark it
 * accepted, insert the membership with its roles, append `invitation.accepted`. The caller has
 * verified the token (a `pre-auth` system read) and the invitee's email, and runs the unit of work
 * as `{ invitee, invitation.tenantId, invitation.roles }`; the elevation covers these writes only.
 * @throws TenantAccessDeniedException when the principal is not the invitee in that tenant
 * @throws MembershipAlreadyExistsException, InvitationInvalidException (a concurrent accept won)
 */
@Injectable()
export class InvitationAcceptance {
  constructor(
    private readonly invitations: InvitationsRepository,
    private readonly memberships: MembershipsRepository,
    private readonly audit: TenantAuditLog,
    private readonly elevation: RlsElevation,
  ) {}

  async accept(invitation: InvitationRecord, userId: string, now: Date): Promise<void> {
    const principal = requirePrincipal();
    if (
      principal.userId !== userId ||
      principal.tenantId !== invitation.tenantId ||
      principal.staff
    ) {
      throw new TenantAccessDeniedException();
    }
    await this.elevation.justified('verified-invitation', async () => {
      if ((await this.memberships.find(invitation.tenantId, userId)) !== null) {
        throw new MembershipAlreadyExistsException();
      }
      if (!(await this.invitations.markAccepted(invitation.tenantId, invitation.id, now))) {
        throw new InvitationInvalidException(); // a concurrent accept won
      }
      await this.memberships.insert({
        tenantId: invitation.tenantId,
        userId,
        roles: invitation.roles,
        lastActiveAt: null,
      });
      await this.audit.record({
        tenantId: invitation.tenantId,
        actorId: userId,
        type: AUDIT_EVENT_TYPES.INVITATION_ACCEPTED,
        data: { invitationId: invitation.id, roles: [...invitation.roles] },
        now,
      });
    });
  }
}

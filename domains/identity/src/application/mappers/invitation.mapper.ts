import type { Invitation } from '@domain/identity-contracts';
import type { InvitationRecord } from '../persistence/invitations.repository.js';

/** The invitation as clients see it: never the token hash. */
export function toInvitationContract(invitation: InvitationRecord): Invitation {
  return {
    id: invitation.id,
    tenantId: invitation.tenantId,
    email: invitation.email,
    roles: [...invitation.roles],
    expiresAt: invitation.expiresAt,
    createdAt: invitation.createdAt,
  };
}

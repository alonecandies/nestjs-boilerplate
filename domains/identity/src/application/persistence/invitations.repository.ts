import type { TenantRole } from '@platform/common';

export interface InvitationRecord {
  readonly tenantId: string;
  readonly id: string;
  readonly email: string;
  readonly roles: readonly TenantRole[];
  readonly tokenHash: string;
  readonly invitedBy: string;
  readonly expiresAt: Date;
  readonly acceptedAt: Date | null;
  readonly createdAt: Date;
}

export interface NewInvitation {
  tenantId: string;
  id: string;
  email: string;
  roles: readonly TenantRole[];
  tokenHash: string;
  invitedBy: string;
  expiresAt: Date;
}

/**
 * Invitations persistence port on the runtime pool (`identity.invitations`, distributed by
 * tenant_id; every call needs an elevated unit of work). The token lookup is
 * `InvitationsSystemRepository.findByTokenHash`.
 */
export abstract class InvitationsRepository {
  abstract insert(invitation: NewInvitation): Promise<void>;

  /** Not accepted and `expires_at > now`, newest first. */
  abstract listPending(tenantId: string, now: Date): Promise<InvitationRecord[]>;

  /** Conditional (`accepted_at IS NULL AND expires_at > now`); `true` when this call accepted it. */
  abstract markAccepted(tenantId: string, id: string, now: Date): Promise<boolean>;
}

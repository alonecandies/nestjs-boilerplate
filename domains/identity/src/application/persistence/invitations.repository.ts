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

/** Invitations persistence port (`identity.invitations`, distributed by tenant_id). */
export abstract class InvitationsRepository {
  abstract insert(invitation: NewInvitation): Promise<void>;

  /**
   * System method 3 (spec §9): the accept flow knows only the token. A multi-shard read on Citus;
   * B3-11 moves it into a `*.system-repository.ts` on the BYPASSRLS pool.
   */
  abstract findByTokenHash(tokenHash: string): Promise<InvitationRecord | null>;

  /** Not accepted and `expires_at > now`, newest first. */
  abstract listPending(tenantId: string, now: Date): Promise<InvitationRecord[]>;

  /** Conditional (`accepted_at IS NULL AND expires_at > now`); `true` when this call accepted it. */
  abstract markAccepted(tenantId: string, id: string, now: Date): Promise<boolean>;
}

import { Injectable } from '@nestjs/common';
import { type DrizzleTransactionalAdapter, TransactionHost } from '@platform/database';
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import type {
  InvitationRecord,
  InvitationsRepository,
  NewInvitation,
} from '../../application/persistence/invitations.repository.js';
import { type IdentitySchema, invitations } from './identity.schema.js';

@Injectable()
export class DrizzleInvitationsRepository implements InvitationsRepository {
  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactionalAdapter<IdentitySchema>>,
  ) {}

  async insert(invitation: NewInvitation): Promise<void> {
    await this.txHost.tx
      .insert(invitations)
      .values({ ...invitation, roles: [...invitation.roles] });
  }

  async findByTokenHash(tokenHash: string): Promise<InvitationRecord | null> {
    const [row] = await this.txHost.tx
      .select()
      .from(invitations)
      .where(eq(invitations.tokenHash, tokenHash))
      .limit(1);
    return row ?? null;
  }

  async listPending(tenantId: string, now: Date): Promise<InvitationRecord[]> {
    return this.txHost.tx
      .select()
      .from(invitations)
      .where(
        and(
          eq(invitations.tenantId, tenantId),
          isNull(invitations.acceptedAt),
          gt(invitations.expiresAt, now),
        ),
      )
      .orderBy(desc(invitations.id));
  }

  async markAccepted(tenantId: string, id: string, now: Date): Promise<boolean> {
    const rows = await this.txHost.tx
      .update(invitations)
      .set({ acceptedAt: now })
      .where(
        and(
          eq(invitations.tenantId, tenantId),
          eq(invitations.id, id),
          isNull(invitations.acceptedAt),
          gt(invitations.expiresAt, now),
        ),
      )
      .returning({ id: invitations.id });
    return rows.length > 0;
  }
}

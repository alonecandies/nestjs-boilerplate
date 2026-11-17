import { Injectable } from '@nestjs/common';
import {
  type DrizzleTransactionalAdapter,
  inUnitOfWork,
  TransactionHost,
} from '@platform/database';
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import type {
  InvitationRecord,
  InvitationsRepository,
  NewInvitation,
} from '../../application/persistence/invitations.repository.js';
import { type IdentitySchema, invitations } from './identity.schema.js';

/** Invitations on the runtime pool; every method is a unit of work (`inUnitOfWork`). */
@Injectable()
export class DrizzleInvitationsRepository implements InvitationsRepository {
  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactionalAdapter<IdentitySchema>>,
  ) {}

  async insert(invitation: NewInvitation): Promise<void> {
    await inUnitOfWork(this.txHost, (tx) =>
      tx.insert(invitations).values({ ...invitation, roles: [...invitation.roles] }),
    );
  }

  async listPending(tenantId: string, now: Date): Promise<InvitationRecord[]> {
    return inUnitOfWork(this.txHost, (tx) =>
      tx
        .select()
        .from(invitations)
        .where(
          and(
            eq(invitations.tenantId, tenantId),
            isNull(invitations.acceptedAt),
            gt(invitations.expiresAt, now),
          ),
        )
        .orderBy(desc(invitations.id)),
    );
  }

  async markAccepted(tenantId: string, id: string, now: Date): Promise<boolean> {
    const rows = await inUnitOfWork(this.txHost, (tx) =>
      tx
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
        .returning({ id: invitations.id }),
    );
    return rows.length > 0;
  }
}

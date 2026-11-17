import { Injectable } from '@nestjs/common';
import {
  type DrizzleTransactionalAdapter,
  inUnitOfWork,
  TransactionHost,
} from '@platform/database';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type {
  NewSession,
  RotateSessionInput,
  SessionRecord,
  SessionsRepository,
} from '../../application/persistence/sessions.repository.js';
import { type IdentitySchema, sessions } from './identity.schema.js';

/**
 * Sessions on the runtime pool. Every method is a unit of work (`inUnitOfWork`), so rotation
 * (revoke + insert successor) is atomic inside `TransactionRunner.run()`, and a standalone call
 * runs under the principal's RLS context (own sessions only).
 */
@Injectable()
export class DrizzleSessionsRepository implements SessionsRepository {
  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactionalAdapter<IdentitySchema>>,
  ) {}

  async create(session: NewSession): Promise<void> {
    await inUnitOfWork(this.txHost, (tx) => tx.insert(sessions).values(session));
  }

  async findById(userId: string, id: string): Promise<SessionRecord | null> {
    const [row] = await inUnitOfWork(this.txHost, (tx) =>
      tx
        .select()
        .from(sessions)
        .where(and(eq(sessions.userId, userId), eq(sessions.id, id)))
        .limit(1),
    );
    return row ?? null;
  }

  /**
   * One conditional UPDATE is the compare-and-set: under concurrent refreshes of the same token
   * exactly one statement matches `revoked_at IS NULL`; the loser sees 0 rows (→ reuse).
   */
  async revokeForRotation(input: RotateSessionInput): Promise<boolean> {
    const rows = await inUnitOfWork(this.txHost, (tx) =>
      tx
        .update(sessions)
        .set({ revokedAt: input.now, replacedById: input.replacedById })
        .where(
          and(
            eq(sessions.id, input.id),
            eq(sessions.userId, input.userId),
            eq(sessions.refreshTokenHash, input.refreshTokenHash),
            isNull(sessions.revokedAt),
            gt(sessions.expiresAt, input.now),
          ),
        )
        .returning({ id: sessions.id }),
    );
    return rows.length > 0;
  }

  async revoke(input: { id: string; userId: string; now: Date }): Promise<boolean> {
    const rows = await inUnitOfWork(this.txHost, (tx) =>
      tx
        .update(sessions)
        .set({ revokedAt: input.now })
        .where(
          and(
            eq(sessions.id, input.id),
            eq(sessions.userId, input.userId),
            isNull(sessions.revokedAt),
          ),
        )
        .returning({ id: sessions.id }),
    );
    return rows.length > 0;
  }

  async revokeAllForUser(userId: string, now: Date): Promise<number> {
    // No RETURNING: postgres.js reports the affected row count (`RowList.count`).
    const result = await inUnitOfWork(this.txHost, (tx) =>
      tx
        .update(sessions)
        .set({ revokedAt: now })
        .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt))),
    );
    return result.count;
  }
}

import { type DrizzleTransactionalAdapter, TransactionHost } from '@app/database';
import { Injectable } from '@nestjs/common';
import { and, eq, gt, inArray, isNull, lte } from 'drizzle-orm';
import type {
  NewSession,
  RotateSessionInput,
  SessionRecord,
  SessionsRepository,
} from '../../application/persistence/sessions.repository.js';
import { type IdentitySchema, sessions } from './identity.schema.js';

/**
 * Sessions over Drizzle. Every statement goes through `txHost.tx`, so rotation (revoke +
 * insert successor) is atomic when called inside `TransactionRunner.run()`.
 */
@Injectable()
export class DrizzleSessionsRepository implements SessionsRepository {
  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactionalAdapter<IdentitySchema>>,
  ) {}

  async create(session: NewSession): Promise<void> {
    await this.txHost.tx.insert(sessions).values(session);
  }

  async findById(id: string): Promise<SessionRecord | null> {
    const [row] = await this.txHost.tx.select().from(sessions).where(eq(sessions.id, id)).limit(1);
    return row ?? null;
  }

  /**
   * One conditional UPDATE is the compare-and-set: under concurrent refreshes of the same token
   * exactly one statement matches `revoked_at IS NULL`; the loser sees 0 rows (→ reuse).
   */
  async revokeForRotation(input: RotateSessionInput): Promise<boolean> {
    const rows = await this.txHost.tx
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
      .returning({ id: sessions.id });
    return rows.length > 0;
  }

  async revoke(input: { id: string; userId: string; now: Date }): Promise<boolean> {
    const rows = await this.txHost.tx
      .update(sessions)
      .set({ revokedAt: input.now })
      .where(
        and(
          eq(sessions.id, input.id),
          eq(sessions.userId, input.userId),
          isNull(sessions.revokedAt),
        ),
      )
      .returning({ id: sessions.id });
    return rows.length > 0;
  }

  async revokeAllForUser(userId: string, now: Date): Promise<number> {
    // No RETURNING: postgres.js reports the affected row count (`RowList.count`).
    const result = await this.txHost.tx
      .update(sessions)
      .set({ revokedAt: now })
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
    return result.count;
  }

  /** `DELETE … WHERE id IN (SELECT id … LIMIT n)`: bounded batches (sessions_expires_at_idx). */
  async deleteExpired(now: Date, limit: number): Promise<number> {
    const tx = this.txHost.tx;
    const result = await tx
      .delete(sessions)
      .where(
        inArray(
          sessions.id,
          tx
            .select({ id: sessions.id })
            .from(sessions)
            .where(lte(sessions.expiresAt, now))
            .limit(limit),
        ),
      );
    return result.count;
  }
}

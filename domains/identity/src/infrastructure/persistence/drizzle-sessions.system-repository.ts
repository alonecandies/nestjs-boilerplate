import { Injectable } from '@nestjs/common';
import { InjectSystemDatabase, purgeInTimeSlices, SystemDatabase } from '@platform/database';
import { lte, min } from 'drizzle-orm';
import type { SessionsSystemRepository } from '../../application/persistence/sessions.system-repository.js';
import { type IdentitySchema, sessions } from './identity.schema.js';
import { IDENTITY_SYSTEM_METHODS } from './identity.system-methods.js';

/** `SessionsSystemRepository` on the app_system pool, one named system method per call. */
@Injectable()
export class DrizzleSessionsSystemRepository implements SessionsSystemRepository {
  constructor(@InjectSystemDatabase() private readonly system: SystemDatabase<IdentitySchema>) {}

  /**
   * Deletes `expires_at <= $now` in time slices, oldest first (`purgeInTimeSlices`): read
   * `min(expires_at)` of the due rows, delete up to min + 15 minutes, repeat, at most 96 slices per
   * run. Each statement is one multi-shard statement on the user-distributed table (each shard uses
   * sessions_expires_at_idx) that commits on its own; no `LIMIT`ed sub-select, which Citus cannot
   * push down. A slice stays far below the role's `statement_timeout`, so a backlog drains over a
   * few runs instead of timing out every hour.
   */
  deleteExpired(now: Date): Promise<number> {
    return this.system.run(IDENTITY_SYSTEM_METHODS.sessions.deleteExpired, async (db) => {
      const { deleted } = await purgeInTimeSlices({
        cutoff: now,
        oldestDue: async () => {
          const [row] = await db
            .select({ oldest: min(sessions.expiresAt) })
            .from(sessions)
            .where(lte(sessions.expiresAt, now));
          return row?.oldest ?? null;
        },
        // No RETURNING: postgres.js reports the affected row count (`RowList.count`).
        deleteThrough: async (bound) =>
          (await db.delete(sessions).where(lte(sessions.expiresAt, bound))).count,
      });
      return deleted;
    });
  }
}

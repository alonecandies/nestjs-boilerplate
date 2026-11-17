import { Injectable } from '@nestjs/common';
import { InjectSystemDatabase, SystemDatabase } from '@platform/database';
import { lte } from 'drizzle-orm';
import type { SessionsSystemRepository } from '../../application/persistence/sessions.system-repository.js';
import { type IdentitySchema, sessions } from './identity.schema.js';
import { IDENTITY_SYSTEM_METHODS } from './identity.system-methods.js';

/** `SessionsSystemRepository` on the app_system pool, one named system method per call. */
@Injectable()
export class DrizzleSessionsSystemRepository implements SessionsSystemRepository {
  constructor(@InjectSystemDatabase() private readonly system: SystemDatabase<IdentitySchema>) {}

  /**
   * `DELETE … WHERE expires_at <= $now`: one multi-shard statement (Citus runs it on every shard
   * of the user-distributed table, each using sessions_expires_at_idx). No `LIMIT`ed sub-select:
   * Citus cannot push one down once sessions are distributed. The run is bounded by the role's
   * `statement_timeout` instead of a batch size.
   */
  deleteExpired(now: Date): Promise<number> {
    return this.system.run(IDENTITY_SYSTEM_METHODS.sessions.deleteExpired, async (db) => {
      // No RETURNING: postgres.js reports the affected row count (`RowList.count`).
      const result = await db.delete(sessions).where(lte(sessions.expiresAt, now));
      return result.count;
    });
  }
}

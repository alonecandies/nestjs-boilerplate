/** Sessions maintenance on the system pool (BYPASSRLS; identity's named system methods). */
export abstract class SessionsSystemRepository {
  /**
   * `system` (spec §9 method 5; inside `SystemContext.run` only): deletes the sessions whose
   * `expiresAt <= now`, oldest first in 15-minute time slices (at most 96 per call, each one
   * multi-shard DELETE without row locks, far below the role's `statement_timeout`); returns how
   * many went. A larger backlog is left for the next call.
   */
  abstract deleteExpired(now: Date): Promise<number>;
}

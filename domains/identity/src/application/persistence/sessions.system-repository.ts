/** Sessions maintenance on the system pool (BYPASSRLS; identity's named system methods). */
export abstract class SessionsSystemRepository {
  /**
   * `system` (spec §9 method 5; inside `SystemContext.run` only): deletes every session whose
   * `expiresAt <= now` in one statement; returns how many. Sessions are distributed by `user_id`,
   * so this is a multi-shard DELETE without row locks, bounded by the role's `statement_timeout`.
   */
  abstract deleteExpired(now: Date): Promise<number>;
}

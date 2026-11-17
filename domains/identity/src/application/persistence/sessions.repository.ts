import type { SessionState } from '../../domain/session.js';

export interface SessionRecord extends SessionState {
  readonly tenantId: string;
  readonly userAgent: string | null;
  readonly ip: string | null;
  /** The session that replaced this one on rotation. */
  readonly replacedById: string | null;
  readonly createdAt: Date;
}

export interface NewSession {
  /** = the refresh token's `jti`. */
  id: string;
  userId: string;
  /** The tenant this session (and its refresh token) belongs to. */
  tenantId: string;
  /** `sha256Hex(refreshToken)` — the token itself is never stored. */
  refreshTokenHash: string;
  userAgent: string | null;
  ip: string | null;
  expiresAt: Date;
}

export interface RotateSessionInput {
  id: string;
  userId: string;
  refreshTokenHash: string;
  replacedById: string;
  now: Date;
}

/** Sessions persistence port (implemented by `DrizzleSessionsRepository`). */
export abstract class SessionsRepository {
  abstract create(session: NewSession): Promise<void>;

  /** By (user_id, id): a router query once sessions are distributed by user_id. */
  abstract findById(userId: string, id: string): Promise<SessionRecord | null>;

  /**
   * Atomically revokes the session iff it is still active AND bound to this user and token hash
   * (a single conditional UPDATE — concurrent refreshes of one token cannot both win). Returns
   * `true` when this call revoked it.
   */
  abstract revokeForRotation(input: RotateSessionInput): Promise<boolean>;

  /** Revokes one active session of `userId`; `false` if it was not active. */
  abstract revoke(input: { id: string; userId: string; now: Date }): Promise<boolean>;

  /** Revokes every active session of the user; returns how many. */
  abstract revokeAllForUser(userId: string, now: Date): Promise<number>;

  /**
   * Deletes every session whose `expiresAt <= now` in one statement; returns how many. Sessions are
   * distributed by `user_id`, so this is a multi-shard DELETE without row locks (a `LIMIT`ed
   * sub-select cannot be pushed down to the shards).
   */
  abstract deleteExpired(now: Date): Promise<number>;
}

import { timingSafeEqualStr } from '@app/common';

/**
 * A login session = one refresh-token family member. The refresh JWT's `jti` is the session id and
 * only `sha256(refreshToken)` is stored, so a database leak does not leak usable tokens.
 * Rotation revokes the presented session and links it to its successor (`replacedById`).
 */
export interface SessionState {
  readonly id: string;
  readonly userId: string;
  readonly refreshTokenHash: string;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

export interface RefreshAttempt {
  /** `sub` of the (signature-verified) refresh token. */
  readonly userId: string;
  readonly refreshTokenHash: string;
  readonly now: Date;
}

/**
 * Why a refresh attempt could not rotate the session:
 * - `reused`: the token is genuine (right user, right hash) but its session was already revoked —
 *   a rotated token came back, i.e. theft. The caller must revoke the whole user's sessions.
 * - `expired`: genuine and never revoked, but past its expiry.
 * - `invalid`: unknown session, other user, or hash mismatch (forged / foreign token).
 */
export type RefreshRejection = 'invalid' | 'reused' | 'expired';

export function isSessionActive(session: SessionState, now: Date): boolean {
  return session.revokedAt === null && session.expiresAt.getTime() > now.getTime();
}

/**
 * Classifies a failed rotation (the atomic "revoke if active" matched no row). Revocation is
 * checked before expiry: a revoked token replayed after its expiry is still a reuse signal.
 */
export function classifyRefreshRejection(
  session: SessionState | null,
  attempt: RefreshAttempt,
): RefreshRejection {
  if (
    session === null ||
    session.userId !== attempt.userId ||
    !timingSafeEqualStr(session.refreshTokenHash, attempt.refreshTokenHash)
  ) {
    return 'invalid';
  }
  if (session.revokedAt !== null) return 'reused';
  if (session.expiresAt.getTime() <= attempt.now.getTime()) return 'expired';
  // Active session that still did not rotate: only possible if it was rotated and un-revoked in
  // between (never happens) — refuse rather than guess.
  return 'invalid';
}

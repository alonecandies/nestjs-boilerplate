import { randomBytes } from 'node:crypto';
import { sha256Hex } from '@platform/common';

/** Invitations expire 7 days after they are sent (spec §5.1). */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const INVITATION_TOKEN_BYTES = 32;

/** What `identity.invitations.token_hash` stores for a raw token (the raw token is never stored). */
export function hashInvitationToken(token: string): string {
  return sha256Hex(token);
}

/** A fresh raw token (base64url of 32 random bytes, mailed once) and its hash (stored). */
export function generateInvitationToken(): { token: string; tokenHash: string } {
  const token = randomBytes(INVITATION_TOKEN_BYTES).toString('base64url');
  return { token, tokenHash: hashInvitationToken(token) };
}

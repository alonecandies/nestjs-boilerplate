import { sha256Hex } from '@platform/common';
import { describe, expect, it } from 'vitest';
import {
  generateInvitationToken,
  hashInvitationToken,
  INVITATION_TOKEN_BYTES,
  INVITATION_TTL_MS,
} from './invitation-token.js';

describe('invitation tokens', () => {
  it('are 32 random bytes in base64url, stored only as their sha256', () => {
    const { token, tokenHash } = generateInvitationToken();
    expect(INVITATION_TOKEN_BYTES).toBe(32);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(tokenHash).toBe(sha256Hex(token));
    expect(hashInvitationToken(token)).toBe(tokenHash);
    expect(generateInvitationToken().token).not.toBe(token);
  });

  it('expire after 7 days', () => {
    expect(INVITATION_TTL_MS).toBe(604_800_000);
  });
});

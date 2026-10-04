import { describe, expect, it } from 'vitest';
import { classifyRefreshRejection, isSessionActive, type SessionState } from './session.js';

const NOW = new Date('2026-09-29T12:00:00.000Z');
const future = new Date(NOW.getTime() + 60_000);
const past = new Date(NOW.getTime() - 60_000);

const session = (overrides: Partial<SessionState> = {}): SessionState => ({
  id: 's-1',
  userId: 'u-1',
  refreshTokenHash: 'a'.repeat(64),
  expiresAt: future,
  revokedAt: null,
  ...overrides,
});
const attempt = { userId: 'u-1', refreshTokenHash: 'a'.repeat(64), now: NOW };

describe('session rules', () => {
  it('isSessionActive: not revoked and not expired', () => {
    expect(isSessionActive(session(), NOW)).toBe(true);
    expect(isSessionActive(session({ revokedAt: past }), NOW)).toBe(false);
    expect(isSessionActive(session({ expiresAt: NOW }), NOW)).toBe(false);
  });

  describe('classifyRefreshRejection', () => {
    it('invalid: unknown session, other user or hash mismatch', () => {
      expect(classifyRefreshRejection(null, attempt)).toBe('invalid');
      expect(classifyRefreshRejection(session({ userId: 'u-2' }), attempt)).toBe('invalid');
      expect(classifyRefreshRejection(session({ refreshTokenHash: 'b'.repeat(64) }), attempt)).toBe(
        'invalid',
      );
    });

    it('reused: a genuine token whose session was already revoked (even if since expired)', () => {
      expect(classifyRefreshRejection(session({ revokedAt: past }), attempt)).toBe('reused');
      expect(classifyRefreshRejection(session({ revokedAt: past, expiresAt: past }), attempt)).toBe(
        'reused',
      );
    });

    it('expired: genuine, never revoked, past expiry', () => {
      expect(classifyRefreshRejection(session({ expiresAt: past }), attempt)).toBe('expired');
    });

    it('an active session that did not rotate is refused as invalid', () => {
      expect(classifyRefreshRejection(session(), attempt)).toBe('invalid');
    });
  });
});

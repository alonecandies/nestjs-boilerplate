import { describe, expect, it } from 'vitest';
import { MemberPageResponse, MemberResponse } from './member.response.js';

describe('MemberResponse', () => {
  const joinedAt = new Date('2026-11-01T10:00:00.000Z');

  it('mixed versions: a complete member (an old identity-service sends every field) passes through unchanged', () => {
    expect(
      MemberResponse.from({
        userId: 'u',
        email: 'a@b.io',
        displayName: 'A',
        roles: ['member', 'owner'],
        joinedAt,
      }),
    ).toEqual({
      userId: 'u',
      email: 'a@b.io',
      displayName: 'A',
      roles: ['owner', 'member'],
      joinedAt: '2026-11-01T10:00:00.000Z',
    });
  });

  it('a withheld member (ARCH-4: "" and [] on the wire) has null email and roles', () => {
    const page = MemberPageResponse.from({
      items: [{ userId: 'u', email: '', displayName: 'A', roles: [], joinedAt }],
    });
    expect(page.items[0]).toEqual({
      userId: 'u',
      email: null,
      displayName: 'A',
      roles: null,
      joinedAt: '2026-11-01T10:00:00.000Z',
    });
    expect(page.nextCursor).toBeNull();
  });
});

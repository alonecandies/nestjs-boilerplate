import { describe, expect, it } from 'vitest';
import { makeUser } from '../../../../test/fixtures.js';
import {
  normalizeAuthTokens,
  normalizeUser,
  normalizeUserPage,
} from './grpc-contract.normalizer.js';

describe('gRPC contract normalizers (proto-loader defaults: absent message → null)', () => {
  it('turns null message fields into undefined / defaults', () => {
    expect(
      normalizeUser({ id: 'u', email: 'e', displayName: 'd', roles: null, createdAt: null }),
    ).toEqual({
      id: 'u',
      email: 'e',
      displayName: 'd',
      roles: [],
      createdAt: undefined,
      updatedAt: undefined,
    });
    expect(normalizeAuthTokens({ accessToken: 'a', user: null })).toMatchObject({
      accessToken: 'a',
      refreshToken: '',
      user: undefined,
    });
  });

  it('keeps nextCursor only when present and non-empty', () => {
    const user = makeUser();
    expect(normalizeUserPage({ items: [user], nextCursor: 'n' })).toEqual({
      items: [user],
      nextCursor: 'n',
    });
    expect(normalizeUserPage({ items: null })).toEqual({ items: [] });
    expect(normalizeUserPage({ items: [], nextCursor: '' })).not.toHaveProperty('nextCursor');
  });
});

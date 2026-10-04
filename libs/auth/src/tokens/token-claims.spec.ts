import { UnauthenticatedException } from '@app/common';
import { describe, expect, it } from 'vitest';
import { Permission } from '../rbac/permission.enum.js';
import { Role } from '../rbac/role.enum.js';
import { makeAuthUser } from '../testing/auth-test.utils.js';
import {
  isAuthUser,
  parseAccessTokenClaims,
  parseRefreshTokenClaims,
  toAuthUser,
} from './token-claims.js';

const access = {
  sub: 'u1',
  email: 'a@b.c',
  roles: ['user'],
  typ: 'access',
  jti: 'j1',
  iat: 100,
  exp: 1_000,
  iss: 'nestjs-boilerplate',
  aud: 'nestjs-boilerplate',
};

const rejects = (fn: () => unknown, reason: RegExp): void => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(UnauthenticatedException);
    expect((error as UnauthenticatedException).code).toBe('INVALID_TOKEN');
    expect(JSON.stringify((error as UnauthenticatedException).details)).toMatch(reason);
    return;
  }
  throw new Error('expected a rejection');
};

describe('parseAccessTokenClaims', () => {
  it('accepts well-formed access claims', () => {
    expect(parseAccessTokenClaims(access)).toEqual({ ...access, roles: [Role.User] });
  });

  it('rejects refresh tokens and malformed payloads', () => {
    rejects(() => parseAccessTokenClaims({ ...access, typ: 'refresh' }), /expected a access token/);
    rejects(() => parseAccessTokenClaims({ ...access, typ: undefined }), /expected a access/);
    rejects(() => parseAccessTokenClaims('token'), /not an object/);
    rejects(() => parseAccessTokenClaims({ ...access, sub: '' }), /sub\/jti/);
    rejects(() => parseAccessTokenClaims({ ...access, exp: '1000' }), /iat\/exp/);
    rejects(() => parseAccessTokenClaims({ ...access, aud: undefined }), /iss\/aud/);
    rejects(() => parseAccessTokenClaims({ ...access, roles: 'user' }), /roles/);
    rejects(() => parseAccessTokenClaims({ ...access, email: 1 }), /email/);
  });

  it('drops roles this service does not know (rolling deploys, least privilege)', () => {
    expect(parseAccessTokenClaims({ ...access, roles: ['user', 'superhero', 7] }).roles).toEqual([
      Role.User,
    ]);
  });
});

describe('parseRefreshTokenClaims', () => {
  it('accepts refresh claims and rejects access tokens', () => {
    const refresh = {
      sub: 'u1',
      jti: 'session-1',
      typ: 'refresh',
      iat: 1,
      exp: 2,
      iss: 'i',
      aud: 'a',
    };
    expect(parseRefreshTokenClaims({ ...refresh, extra: true })).toEqual(refresh);
    rejects(() => parseRefreshTokenClaims(access), /expected a refresh token/);
  });
});

describe('toAuthUser / isAuthUser', () => {
  it('maps claims to the principal with resolved permissions', () => {
    const user = toAuthUser(parseAccessTokenClaims({ ...access, roles: ['moderator'] }));
    expect(user).toEqual({
      id: 'u1',
      email: 'a@b.c',
      roles: [Role.Moderator],
      permissions: expect.arrayContaining([Permission.UsersRead, Permission.NotificationsWrite]),
      jti: 'j1',
      exp: 1_000,
    });
    expect(isAuthUser(user)).toBe(true);
  });

  it('rejects anything that is not a full AuthUser', () => {
    expect(isAuthUser(makeAuthUser())).toBe(true);
    expect(isAuthUser(undefined)).toBe(false);
    expect(isAuthUser({ id: 'u1' })).toBe(false);
    expect(isAuthUser({ ...makeAuthUser(), roles: ['root'] })).toBe(false);
    expect(isAuthUser({ ...makeAuthUser(), permissions: ['files:*'] })).toBe(false);
    expect(isAuthUser({ ...makeAuthUser(), exp: 'soon' })).toBe(false);
  });
});

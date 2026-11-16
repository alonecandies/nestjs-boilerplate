import { PLATFORM_TENANT_ID, UnauthenticatedException } from '@platform/common';
import { describe, expect, it } from 'vitest';
import { makeAuthUser } from '../testing/auth-test.utils.js';
import { TEST_TENANT_ID } from '../testing/test-tenant.js';
import {
  isAuthUser,
  parseAccessTokenClaims,
  parseRefreshTokenClaims,
  toAuthUser,
} from './token-claims.js';

const access = {
  sub: 'u1',
  email: 'a@b.c',
  tid: TEST_TENANT_ID,
  roles: ['member'],
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
  it('accepts well-formed access claims; staff defaults to false', () => {
    expect(parseAccessTokenClaims(access)).toEqual({ ...access, roles: ['member'], staff: false });
  });

  it('rejects refresh tokens and malformed payloads', () => {
    rejects(() => parseAccessTokenClaims({ ...access, typ: 'refresh' }), /expected a access token/);
    rejects(() => parseAccessTokenClaims({ ...access, typ: undefined }), /expected a access/);
    rejects(() => parseAccessTokenClaims('token'), /not an object/);
    rejects(() => parseAccessTokenClaims({ ...access, sub: '' }), /sub\/jti/);
    rejects(() => parseAccessTokenClaims({ ...access, exp: '1000' }), /iat\/exp/);
    rejects(() => parseAccessTokenClaims({ ...access, aud: undefined }), /iss\/aud/);
    rejects(() => parseAccessTokenClaims({ ...access, email: 1 }), /email/);
  });

  // Review Focus 2: hostile or legacy claims.
  it.each([
    ['a pre-B2 token without tid', { tid: undefined }, /missing or malformed tid/],
    ['a tid that is not a UUID', { tid: 'tenant-1' }, /missing or malformed tid/],
    ['a numeric tid', { tid: 7 }, /missing or malformed tid/],
    ['the platform tenant', { tid: PLATFORM_TENANT_ID }, /platform tenant/],
    ['roles that are not an array', { roles: 'member' }, /missing roles/],
    ['roles that are an object', { roles: { 0: 'owner' } }, /missing roles/],
  ])('rejects %s with 401 INVALID_TOKEN and a reason', (_name, patch, reason) => {
    rejects(() => parseAccessTokenClaims({ ...access, ...patch }), reason);
  });

  it('lower-cases a UUID tid and a UUID sub so ids compare equal everywhere', () => {
    const parsed = parseAccessTokenClaims({
      ...access,
      sub: '0190F3B2-0000-7000-8000-0000000000AB',
      tid: TEST_TENANT_ID.toUpperCase(),
    });
    expect(parsed.tid).toBe(TEST_TENANT_ID);
    expect(parsed.sub).toBe('0190f3b2-0000-7000-8000-0000000000ab');
  });

  it('drops unknown roles, removes duplicates and keeps the canonical order', () => {
    expect(
      parseAccessTokenClaims({
        ...access,
        roles: ['member', 'superhero', 7, 'owner', 'member', 'user', 'admin'],
      }).roles,
    ).toEqual(['owner', 'admin', 'member']);
  });

  it.each([
    [true, true],
    ['true', false],
    [1, false],
    [null, false],
    [undefined, false],
    [{}, false],
  ])('staff %j → %j (only the JSON boolean true counts)', (staff, expected) => {
    expect(parseAccessTokenClaims({ ...access, staff }).staff).toBe(expected);
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
  it('maps claims and the resolved permissions to the principal', () => {
    const user = toAuthUser(parseAccessTokenClaims({ ...access, roles: ['admin'], staff: true }), [
      'orders:read',
    ]);
    expect(user).toEqual({
      id: 'u1',
      email: 'a@b.c',
      tenantId: TEST_TENANT_ID,
      roles: ['admin'],
      staff: true,
      permissions: ['orders:read'],
      jti: 'j1',
      exp: 1_000,
    });
    expect(isAuthUser(user)).toBe(true);
  });

  it('rejects anything that is not a full AuthUser', () => {
    expect(isAuthUser(makeAuthUser())).toBe(true);
    expect(isAuthUser(undefined)).toBe(false);
    expect(isAuthUser({ id: 'u1' })).toBe(false);
    expect(isAuthUser({ ...makeAuthUser(), roles: ['user'] })).toBe(false);
    expect(isAuthUser({ ...makeAuthUser(), permissions: ['files:*'] })).toBe(false);
    expect(isAuthUser({ ...makeAuthUser(), exp: 'soon' })).toBe(false);
    expect(isAuthUser({ ...makeAuthUser(), tenantId: undefined })).toBe(false);
    expect(isAuthUser({ ...makeAuthUser(), staff: 'false' })).toBe(false);
  });
});

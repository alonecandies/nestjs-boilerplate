import { describe, expect, it } from 'vitest';
import { makeUserSnapshot } from '../../../test/fixtures.js';
import { toSessionClient } from './client-info.mapper.js';
import {
  toListUsersQuery,
  toLoginCommand,
  toLogoutCommand,
  toRegisterUserCommand,
  toStaffSwitchInCommand,
  toStaffSwitchOutCommand,
  toSwitchTenantCommand,
} from './identity-request.mapper.js';
import { toAccessTokenSubject, toUserContract, toUserRecord } from './user.mapper.js';

describe('user mappers', () => {
  const snapshot = makeUserSnapshot();

  it('never leak the password hash; global roles are gone (always [])', () => {
    expect(toUserContract(snapshot)).not.toHaveProperty('passwordHash');
    expect(toUserRecord(snapshot)).not.toHaveProperty('passwordHash');
    expect(toUserContract(snapshot)).toEqual({
      id: snapshot.id,
      email: snapshot.email,
      displayName: snapshot.displayName,
      roles: [],
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
    });
  });

  it('builds the access-token subject from the user, the tenant and the tenant roles (never global roles)', () => {
    expect(toAccessTokenSubject(snapshot, 'tenant-1', ['owner'])).toEqual({
      id: snapshot.id,
      email: snapshot.email,
      tenantId: 'tenant-1',
      roles: ['owner'],
    });
  });
});

describe('toSessionClient', () => {
  it('trims, bounds and nulls the attacker-controlled fingerprint', () => {
    expect(toSessionClient({ userAgent: `  ${'x'.repeat(600)} `, ip: ' 10.0.0.1 ' })).toEqual({
      userAgent: 'x'.repeat(512),
      ip: '10.0.0.1',
    });
    expect(toSessionClient({ userAgent: '   ' })).toEqual({ userAgent: null, ip: null });
    expect(toSessionClient(null)).toEqual({ userAgent: null, ip: null });
  });
});

describe('identity request mappers', () => {
  it('map contract requests onto commands/queries (int64 exp string → number)', () => {
    expect(
      toLogoutCommand({ userId: 'u', accessTokenJti: 'j', accessTokenExp: '1900000000' }),
    ).toMatchObject({ userId: 'u', accessTokenJti: 'j', accessTokenExp: 1_900_000_000 });
    expect(
      toRegisterUserCommand({ email: 'e', password: 'p', displayName: 'd', client: { ip: '1' } }),
    ).toMatchObject({ email: 'e', password: 'p', displayName: 'd', client: { ip: '1' } });
    expect(toListUsersQuery({ limit: 5, cursor: 'c' })).toMatchObject({ limit: 5, cursor: 'c' });
  });

  it('toLoginCommand carries the optional tenant as the fourth argument', () => {
    expect(
      toLoginCommand({ email: 'e', password: 'p', client: { ip: '1' }, tenantId: 't-1' }),
    ).toMatchObject({ email: 'e', password: 'p', client: { ip: '1' }, tenantId: 't-1' });
    expect(toLoginCommand({ email: 'e', password: 'p' }).tenantId).toBeUndefined();
  });

  it('toSwitchTenantCommand: int64 exp string → number, the access token as { jti, exp }', () => {
    expect(
      toSwitchTenantCommand({
        userId: 'u',
        tenantId: 't',
        refreshToken: 'r',
        accessTokenJti: 'j',
        accessTokenExp: '1900000000',
      }),
    ).toMatchObject({
      userId: 'u',
      tenantId: 't',
      refreshToken: 'r',
      accessToken: { jti: 'j', exp: 1_900_000_000 },
    });
  });

  it('toStaffSwitchInCommand: carries the staff user, tenant, reason and client', () => {
    expect(
      toStaffSwitchInCommand({
        staffUserId: 's',
        tenantId: 't',
        reason: 'ticket #1',
        client: { ip: '1' },
      }),
    ).toMatchObject({ staffUserId: 's', tenantId: 't', reason: 'ticket #1', client: { ip: '1' } });
  });

  it('toStaffSwitchOutCommand: int64 exp string → number', () => {
    expect(
      toStaffSwitchOutCommand({
        staffUserId: 's',
        tenantId: 't',
        accessTokenJti: 'j',
        accessTokenExp: '1900000000',
      }),
    ).toMatchObject({
      staffUserId: 's',
      tenantId: 't',
      accessToken: { jti: 'j', exp: 1_900_000_000 },
    });
  });
});

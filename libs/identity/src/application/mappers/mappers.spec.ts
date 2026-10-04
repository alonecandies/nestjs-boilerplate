import { describe, expect, it } from 'vitest';
import { makeUserSnapshot } from '../../../test/fixtures.js';
import { toSessionClient } from './client-info.mapper.js';
import {
  toListUsersQuery,
  toLogoutCommand,
  toRegisterUserCommand,
} from './identity-request.mapper.js';
import { toAccessTokenSubject, toUserContract, toUserRecord } from './user.mapper.js';

describe('user mappers', () => {
  const snapshot = makeUserSnapshot({ roles: ['admin', 'user'] });

  it('never leak the password hash, even when handed a full snapshot', () => {
    expect(toUserContract(snapshot)).not.toHaveProperty('passwordHash');
    expect(toUserRecord(snapshot)).not.toHaveProperty('passwordHash');
    expect(toUserContract(snapshot)).toEqual({
      id: snapshot.id,
      email: snapshot.email,
      displayName: snapshot.displayName,
      roles: ['admin', 'user'],
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
    });
  });

  it('builds the access-token subject from id, email and RBAC roles', () => {
    expect(toAccessTokenSubject(snapshot)).toEqual({
      id: snapshot.id,
      email: snapshot.email,
      roles: ['admin', 'user'],
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
});

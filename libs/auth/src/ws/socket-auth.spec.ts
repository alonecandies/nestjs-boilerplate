import { UnauthenticatedException } from '@app/common';
import { authConfig, redisConfig } from '@app/config';
import { RedisKeyService } from '@app/redis';
import { InMemoryRedis } from '@app/redis/testing';
import { JwtService } from '@nestjs/jwt';
import { describe, expect, it } from 'vitest';
import { createJwtModuleOptions } from '../auth.module.js';
import { Role } from '../rbac/role.enum.js';
import { AccessTokenDenylist } from '../tokens/access-token-denylist.service.js';
import { TokenService } from '../tokens/token.service.js';
import { authenticateSocket, extractBearerToken, extractSocketToken } from './socket-auth.js';

const config = authConfig.parse({ NODE_ENV: 'test' });
const tokens = new TokenService(new JwtService(createJwtModuleOptions(config)), config);
const denylist = new AccessTokenDenylist(
  new InMemoryRedis().asRedis(),
  new RedisKeyService(redisConfig.parse({})),
  config,
);

describe('extractBearerToken', () => {
  it.each([
    ['abc.def.ghi', 'abc.def.ghi'],
    ['Bearer abc.def.ghi', 'abc.def.ghi'],
    ['bearer   abc.def.ghi  ', 'abc.def.ghi'],
    ['Basic dXNlcjpwYXNz', undefined],
    ['', undefined],
    ['   ', undefined],
    [undefined, undefined],
    [42, undefined],
  ])('%j -> %j', (input, expected) => {
    expect(extractBearerToken(input)).toBe(expected);
  });
});

describe('extractSocketToken', () => {
  it('prefers handshake.auth.token, then the Authorization header', () => {
    expect(
      extractSocketToken({ auth: { token: 'a.b.c' }, headers: { authorization: 'Bearer x.y.z' } }),
    ).toBe('a.b.c');
    expect(extractSocketToken({ auth: {}, headers: { authorization: 'Bearer x.y.z' } })).toBe(
      'x.y.z',
    );
    expect(extractSocketToken({ headers: { authorization: ['Bearer x.y.z'] } })).toBe('x.y.z');
    expect(extractSocketToken(undefined)).toBeUndefined();
  });
});

describe('authenticateSocket', () => {
  const user = { id: 'u-1', email: 'a@b.c', roles: [Role.Moderator] };

  it('returns the AuthUser for a valid, non-revoked token', async () => {
    const { token, jti } = await tokens.issueAccessToken(user);
    await expect(authenticateSocket(tokens, denylist, `Bearer ${token}`)).resolves.toMatchObject({
      id: 'u-1',
      roles: [Role.Moderator],
      jti,
    });
  });

  it('rejects missing, invalid and revoked tokens with 401 codes', async () => {
    const codeOf = async (token: unknown): Promise<string | undefined> => {
      try {
        await authenticateSocket(tokens, denylist, token);
        return undefined;
      } catch (error) {
        expect(error).toBeInstanceOf(UnauthenticatedException);
        return (error as UnauthenticatedException).code;
      }
    };
    await expect(codeOf(undefined)).resolves.toBe('MISSING_TOKEN');
    await expect(codeOf('not.a.jwt')).resolves.toBe('INVALID_TOKEN');
    const { token, jti, exp } = await tokens.issueAccessToken(user);
    await denylist.deny(jti, exp);
    await expect(codeOf(token)).resolves.toBe('TOKEN_REVOKED');
  });
});

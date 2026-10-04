import { isUuidV7, UnauthenticatedException } from '@app/common';
import { authConfig } from '@app/config';
import { JwtService } from '@nestjs/jwt';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJwtModuleOptions } from '../auth.module.js';
import { Permission } from '../rbac/permission.enum.js';
import { Role } from '../rbac/role.enum.js';
import { TokenService, toUnauthenticated } from './token.service.js';

const config = authConfig.parse({
  NODE_ENV: 'test',
  JWT_ACCESS_TTL_SEC: '900',
  JWT_REFRESH_TTL_SEC: '3600',
});
const jwt = new JwtService(createJwtModuleOptions(config));
const tokens = new TokenService(jwt, config);
const user = { id: '0190f3b2-0000-7000-8000-000000000001', email: 'a@b.c', roles: [Role.User] };

async function expectAuthError(promise: Promise<unknown>, code: string): Promise<void> {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(UnauthenticatedException);
  expect((error as UnauthenticatedException).code).toBe(code);
  expect((error as UnauthenticatedException).httpStatus).toBe(401);
}

describe('TokenService', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('issues an HS256 access token with iss/aud/typ and a uuidv7 jti', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const issued = await tokens.issueAccessToken(user);
    const now = Math.floor(Date.now() / 1_000);
    expect(issued.expiresIn).toBe(900);
    expect(issued.exp).toBe(now + 900);
    expect(isUuidV7(issued.jti)).toBe(true);

    const header = jwt.decode<{ header: { alg: string } }>(issued.token, { complete: true }).header;
    expect(header.alg).toBe('HS256');
    const claims = await tokens.verifyAccessToken(issued.token);
    expect(claims).toEqual({
      sub: user.id,
      email: 'a@b.c',
      roles: [Role.User],
      typ: 'access',
      jti: issued.jti,
      iat: now,
      exp: now + 900,
      iss: 'nestjs-boilerplate',
      aud: 'nestjs-boilerplate',
    });
    expect(tokens.toAuthUser(claims)).toMatchObject({
      id: user.id,
      jti: issued.jti,
      exp: issued.exp,
      permissions: expect.arrayContaining([Permission.BillingCheckout]),
    });
  });

  it('issues refresh tokens whose jti is the session id', async () => {
    const issued = await tokens.issueRefreshToken({ userId: user.id, sessionId: 'session-1' });
    const claims = await tokens.verifyRefreshToken(issued.token);
    expect(claims).toMatchObject({ sub: user.id, jti: 'session-1', typ: 'refresh' });
    expect(issued.expiresAt.getTime()).toBe(claims.exp * 1_000);
    expect(claims.exp - claims.iat).toBe(3_600);
  });

  it('never accepts one token type as the other', async () => {
    const access = await tokens.issueAccessToken(user);
    const refresh = await tokens.issueRefreshToken({ userId: user.id, sessionId: 's' });
    // Different secrets → signature mismatch …
    await expectAuthError(tokens.verifyRefreshToken(access.token), 'INVALID_TOKEN');
    await expectAuthError(tokens.verifyAccessToken(refresh.token), 'INVALID_TOKEN');
    // … and even with the right secret the `typ` claim is enforced.
    const forged = await jwt.signAsync(
      { sub: user.id, jti: 's', typ: 'refresh', email: 'a@b.c', roles: [] },
      { secret: config.accessSecret, expiresIn: 60 },
    );
    await expectAuthError(tokens.verifyAccessToken(forged), 'INVALID_TOKEN');
  });

  it('reports expiry distinctly (TOKEN_EXPIRED) and honours the 5s clock tolerance', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const { token } = await tokens.issueAccessToken(user);
    vi.setSystemTime(Date.now() + (900 + 4) * 1_000);
    await expect(tokens.verifyAccessToken(token)).resolves.toMatchObject({ sub: user.id });
    vi.setSystemTime(Date.now() + 2 * 1_000);
    await expectAuthError(tokens.verifyAccessToken(token), 'TOKEN_EXPIRED');
  });

  it('rejects tampered, foreign-issuer, foreign-audience and empty tokens', async () => {
    const { token } = await tokens.issueAccessToken(user);
    const [head, body, sig] = token.split('.') as [string, string, string];
    const tampered = `${head}.${Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(body, 'base64url').toString()),
        roles: ['admin'],
      }),
    ).toString('base64url')}.${sig}`;
    await expectAuthError(tokens.verifyAccessToken(tampered), 'INVALID_TOKEN');

    const other = new TokenService(
      jwt,
      authConfig.parse({ NODE_ENV: 'test', JWT_ISSUER: 'someone-else', JWT_AUDIENCE: 'other-app' }),
    );
    const foreign = await other.issueAccessToken(user);
    await expectAuthError(tokens.verifyAccessToken(foreign.token), 'INVALID_TOKEN');

    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${body}.`;
    await expectAuthError(tokens.verifyAccessToken(none), 'INVALID_TOKEN');
    await expectAuthError(tokens.verifyAccessToken(''), 'MISSING_TOKEN');
  });

  it('exposes the verification settings shared by every verifier', () => {
    expect(tokens.verificationSettings).toEqual({
      algorithms: ['HS256'],
      issuer: 'nestjs-boilerplate',
      audience: 'nestjs-boilerplate',
      clockTolerance: 5,
    });
  });
});

describe('toUnauthenticated', () => {
  it('maps jsonwebtoken errors by name and keeps our own 401s', () => {
    const expired = Object.assign(new Error('jwt expired'), { name: 'TokenExpiredError' });
    expect(toUnauthenticated(expired).code).toBe('TOKEN_EXPIRED');
    expect(toUnauthenticated(new Error('invalid signature')).code).toBe('INVALID_TOKEN');
    expect(toUnauthenticated('weird').code).toBe('INVALID_TOKEN');
    const own = new UnauthenticatedException('x', { code: 'CUSTOM' });
    expect(toUnauthenticated(own)).toBe(own);
  });
});

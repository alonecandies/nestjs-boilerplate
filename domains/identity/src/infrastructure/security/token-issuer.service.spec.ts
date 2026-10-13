import { JwtService } from '@nestjs/jwt';
import { createJwtModuleOptions, Permission, Role, TokenService } from '@platform/auth';
import { isUuidV7, UnauthenticatedException } from '@platform/common';
import { authConfig } from '@platform/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { refreshTokenConfig } from './refresh-token.config.js';
import { TokenIssuer } from './token-issuer.service.js';

const access = authConfig.parse({ NODE_ENV: 'test', JWT_ACCESS_TTL_SEC: '900' });
const refresh = refreshTokenConfig.parse({ NODE_ENV: 'test', JWT_REFRESH_TTL_SEC: '3600' });
const jwt = new JwtService();
const issuer = new TokenIssuer(jwt, access, refresh);
/** The verifier every edge runs (JwtStrategy and the WS/subscription helpers share its settings). */
const verifier = new TokenService(new JwtService(createJwtModuleOptions(access)), access);
const user = { id: '0190f3b2-0000-7000-8000-000000000001', email: 'a@b.c', roles: [Role.User] };

async function authErrorOf(promise: Promise<unknown>): Promise<UnauthenticatedException> {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(UnauthenticatedException);
  return error as UnauthenticatedException;
}

describe('TokenIssuer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('issues an HS256 access token the platform verifier accepts (iss/aud/typ, uuidv7 jti)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const issued = await issuer.issueAccessToken(user);
    const now = Math.floor(Date.now() / 1_000);
    expect(issued.expiresIn).toBe(900);
    expect(issued.exp).toBe(now + 900);
    expect(isUuidV7(issued.jti)).toBe(true);

    const header = jwt.decode<{ header: { alg: string } }>(issued.token, { complete: true }).header;
    expect(header.alg).toBe('HS256');
    const claims = await verifier.verifyAccessToken(issued.token);
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
    expect(verifier.toAuthUser(claims)).toMatchObject({
      id: user.id,
      jti: issued.jti,
      exp: issued.exp,
      permissions: expect.arrayContaining([Permission.BillingCheckout]),
    });
  });

  it('issues refresh tokens whose jti is the session id, and verifies them', async () => {
    const issued = await issuer.issueRefreshToken({ userId: user.id, sessionId: 'session-1' });
    const claims = await issuer.verifyRefreshToken(issued.token);
    expect(claims).toMatchObject({ sub: user.id, jti: 'session-1', typ: 'refresh' });
    expect(issued.expiresAt.getTime()).toBe(claims.exp * 1_000);
    expect(claims.exp - claims.iat).toBe(3_600);
  });

  it('never accepts one token type as the other', async () => {
    const accessToken = await issuer.issueAccessToken(user);
    const refreshToken = await issuer.issueRefreshToken({ userId: user.id, sessionId: 's' });
    // Different secrets → signature mismatch …
    expect((await authErrorOf(issuer.verifyRefreshToken(accessToken.token))).code).toBe(
      'INVALID_TOKEN',
    );
    expect((await authErrorOf(verifier.verifyAccessToken(refreshToken.token))).code).toBe(
      'INVALID_TOKEN',
    );
    // … and even with the refresh secret, iss and aud the `typ` claim is enforced.
    const forged = await jwt.signAsync(
      { sub: user.id, jti: 's', typ: 'access', email: 'a@b.c', roles: [] },
      {
        secret: refresh.refreshSecret,
        expiresIn: 60,
        issuer: access.issuer,
        audience: access.audience,
      },
    );
    const typMismatch = await authErrorOf(issuer.verifyRefreshToken(forged));
    expect(typMismatch.code).toBe('INVALID_TOKEN');
    expect(typMismatch.details).toEqual({ reason: 'expected a refresh token' });
  });

  it('reports refresh expiry distinctly (TOKEN_EXPIRED) after the 5 s clock tolerance', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const { token } = await issuer.issueRefreshToken({ userId: user.id, sessionId: 's' });
    vi.setSystemTime(Date.now() + (3_600 + 4) * 1_000);
    await expect(issuer.verifyRefreshToken(token)).resolves.toMatchObject({ jti: 's' });
    vi.setSystemTime(Date.now() + 2 * 1_000);
    expect((await authErrorOf(issuer.verifyRefreshToken(token))).code).toBe('TOKEN_EXPIRED');
  });

  it('rejects refresh tokens of another issuer, audience or secret, and empty ones', async () => {
    const foreignIssuer = new TokenIssuer(
      jwt,
      authConfig.parse({ NODE_ENV: 'test', JWT_ISSUER: 'someone-else', JWT_AUDIENCE: 'other-app' }),
      refresh,
    );
    const foreign = await foreignIssuer.issueRefreshToken({ userId: user.id, sessionId: 's' });
    expect((await authErrorOf(issuer.verifyRefreshToken(foreign.token))).code).toBe(
      'INVALID_TOKEN',
    );

    const otherSecret = new TokenIssuer(
      jwt,
      access,
      refreshTokenConfig.parse({ NODE_ENV: 'test', JWT_REFRESH_SECRET: 'r'.repeat(40) }),
    );
    const resigned = await otherSecret.issueRefreshToken({ userId: user.id, sessionId: 's' });
    expect((await authErrorOf(issuer.verifyRefreshToken(resigned.token))).code).toBe(
      'INVALID_TOKEN',
    );

    expect((await authErrorOf(issuer.verifyRefreshToken(''))).code).toBe('MISSING_TOKEN');
  });
});

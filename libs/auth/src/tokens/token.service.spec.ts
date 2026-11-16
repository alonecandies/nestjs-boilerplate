import { JwtService } from '@nestjs/jwt';
import { type TenantRole, UnauthenticatedException } from '@platform/common';
import { authConfig } from '@platform/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJwtModuleOptions } from '../auth.module.js';
import { createTestRbacRegistry, TEST_RBAC_FEATURE } from '../testing/rbac-test.utils.js';
import { signTestAccessToken } from '../testing/sign-test-access-token.js';
import { TEST_TENANT_ID } from '../testing/test-tenant.js';
import { TokenService, toUnauthenticated } from './token.service.js';

const config = authConfig.parse({ NODE_ENV: 'test', JWT_ACCESS_TTL_SEC: '900' });
const jwt = new JwtService(createJwtModuleOptions(config));
const tokens = new TokenService(jwt, config, createTestRbacRegistry(TEST_RBAC_FEATURE));
const user = {
  id: '0190f3b2-0000-7000-8000-000000000001',
  email: 'a@b.c',
  roles: ['member'] satisfies TenantRole[],
};
const sign = () => signTestAccessToken(user, { config });

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

  it('verifies only: issuing tokens belongs to the context that owns sessions', () => {
    for (const method of ['issueAccessToken', 'issueRefreshToken', 'verifyRefreshToken']) {
      expect(method in TokenService.prototype, method).toBe(false);
    }
  });

  it('verifies an HS256 access token claim for claim and maps it to the principal', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const issued = await sign();
    const now = Math.floor(Date.now() / 1_000);

    const claims = await tokens.verifyAccessToken(issued.token);
    expect(claims).toEqual({
      sub: user.id,
      email: 'a@b.c',
      tid: TEST_TENANT_ID,
      roles: ['member'],
      staff: false,
      typ: 'access',
      jti: issued.jti,
      iat: now,
      exp: now + 900,
      iss: 'nestjs-boilerplate',
      aud: 'nestjs-boilerplate',
    });
    expect(tokens.toAuthUser(claims)).toMatchObject({
      id: user.id,
      tenantId: TEST_TENANT_ID,
      staff: false,
      jti: issued.jti,
      exp: issued.exp,
      permissions: expect.arrayContaining(['catalog:buy']),
    });
  });

  it('enforces the typ claim even when the signature, iss and aud are right', async () => {
    const forged = await jwt.signAsync(
      { sub: user.id, jti: 's', typ: 'refresh', email: 'a@b.c', roles: [] },
      {
        secret: config.accessSecret,
        expiresIn: 60,
        issuer: config.issuer,
        audience: config.audience,
      },
    );
    await expectAuthError(tokens.verifyAccessToken(forged), 'INVALID_TOKEN');
    await expect(tokens.verifyAccessToken(forged)).rejects.toMatchObject({
      details: { reason: 'expected a access token' },
    });
  });

  it('reports expiry distinctly (TOKEN_EXPIRED) and honours the 5s clock tolerance', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const { token } = await sign();
    vi.setSystemTime(Date.now() + (900 + 4) * 1_000);
    await expect(tokens.verifyAccessToken(token)).resolves.toMatchObject({ sub: user.id });
    vi.setSystemTime(Date.now() + 2 * 1_000);
    await expectAuthError(tokens.verifyAccessToken(token), 'TOKEN_EXPIRED');
  });

  it('rejects tampered, foreign-issuer, foreign-audience and empty tokens', async () => {
    const { token } = await sign();
    const [head, body, sig] = token.split('.') as [string, string, string];
    const tampered = `${head}.${Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(body, 'base64url').toString()),
        roles: ['admin'],
      }),
    ).toString('base64url')}.${sig}`;
    await expectAuthError(tokens.verifyAccessToken(tampered), 'INVALID_TOKEN');

    const foreign = await signTestAccessToken(user, {
      config: authConfig.parse({
        NODE_ENV: 'test',
        JWT_ISSUER: 'someone-else',
        JWT_AUDIENCE: 'other-app',
      }),
    });
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

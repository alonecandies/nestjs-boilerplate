import { JwtService } from '@nestjs/jwt';
import { isUuidV7, type TenantRole } from '@platform/common';
import { type AuthConfig, authConfig } from '@platform/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJwtModuleOptions } from '../auth.module.js';
import { TokenService } from '../tokens/token.service.js';
import { createTestRbacRegistry } from './rbac-test.utils.js';
import { signTestAccessToken } from './sign-test-access-token.js';
import { TEST_TENANT_ID } from './test-tenant.js';

const config = authConfig.parse({ NODE_ENV: 'test', JWT_ACCESS_TTL_SEC: '600' });
const verifierFor = (settings: AuthConfig): TokenService =>
  new TokenService(
    new JwtService(createJwtModuleOptions(settings)),
    settings,
    createTestRbacRegistry(),
  );
const subject = {
  id: '0190f3b2-0000-7000-8000-000000000001',
  email: 'a@b.c',
  roles: ['admin'] satisfies TenantRole[],
};

describe('signTestAccessToken', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('signs an access token the platform verifier accepts, claim for claim', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const now = Math.floor(Date.now() / 1_000);

    const issued = await signTestAccessToken(subject, { config });

    expect(issued).toMatchObject({ expiresIn: 600, exp: now + 600 });
    expect(isUuidV7(issued.jti)).toBe(true);
    await expect(verifierFor(config).verifyAccessToken(issued.token)).resolves.toEqual({
      sub: subject.id,
      email: 'a@b.c',
      tid: TEST_TENANT_ID,
      roles: ['admin'],
      staff: false,
      typ: 'access',
      jti: issued.jti,
      iat: now,
      exp: now + 600,
      iss: 'nestjs-boilerplate',
      aud: 'nestjs-boilerplate',
    });
  });

  it('writes tenantId when given', async () => {
    const issued = await signTestAccessToken(
      { ...subject, tenantId: '0190f3b2-0000-7000-8000-0000000000aa' },
      { config },
    );
    await expect(verifierFor(config).verifyAccessToken(issued.token)).resolves.toMatchObject({
      tid: '0190f3b2-0000-7000-8000-0000000000aa',
    });
  });

  it('defaults to the auth namespace of process.env, which AuthModule verifies with', async () => {
    const { token } = await signTestAccessToken(subject);
    await expect(verifierFor(authConfig.parse()).verifyAccessToken(token)).resolves.toMatchObject({
      sub: subject.id,
    });
  });

  it('is rejected by a verifier configured for another issuer', async () => {
    const { token } = await signTestAccessToken(subject, { config });
    const foreign = authConfig.parse({ NODE_ENV: 'test', JWT_ISSUER: 'someone-else' });
    await expect(verifierFor(foreign).verifyAccessToken(token)).rejects.toMatchObject({
      code: 'INVALID_TOKEN',
    });
  });
});

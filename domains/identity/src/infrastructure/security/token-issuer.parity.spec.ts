import { JwtService } from '@nestjs/jwt';
import { Role } from '@platform/auth';
import { signTestAccessToken } from '@platform/auth/testing';
import { authConfig } from '@platform/config';
import { describe, expect, it } from 'vitest';
import { refreshTokenConfig } from './refresh-token.config.js';
import { TokenIssuer } from './token-issuer.service.js';

/**
 * Platform and domain specs authenticate with `signTestAccessToken` (`@platform/auth/testing`)
 * instead of identity's issuer, so its tokens must keep matching production issuance. A libs spec
 * cannot import identity: the check lives here. Non-default issuer and audience, so a signer that
 * ignored the config would not match by accident.
 */
const access = authConfig.parse({
  NODE_ENV: 'test',
  JWT_ISSUER: 'parity-issuer',
  JWT_AUDIENCE: 'parity-audience',
  JWT_ACCESS_TTL_SEC: '600',
});
const jwt = new JwtService();
const issuer = new TokenIssuer(jwt, access, refreshTokenConfig.parse({ NODE_ENV: 'test' }));
const subject = {
  id: '0190f3b2-0000-7000-8000-000000000001',
  email: 'a@b.c',
  roles: [Role.Admin, Role.User],
};

type DecodedClaims = Record<string, unknown> & { iat: number; exp: number };

describe('signTestAccessToken parity with TokenIssuer', () => {
  it('signs the claims production issues: same keys; same sub, iss, aud, typ, email, roles and TTL', async () => {
    const issued = jwt.decode<DecodedClaims>((await issuer.issueAccessToken(subject)).token);
    const signed = jwt.decode<DecodedClaims>(
      (await signTestAccessToken(subject, { config: access })).token,
    );

    expect(Object.keys(signed).sort()).toEqual(Object.keys(issued).sort());
    for (const claim of ['sub', 'iss', 'aud', 'typ', 'email', 'roles']) {
      expect(signed[claim], claim).toEqual(issued[claim]);
    }
    // The configured TTL (600 s, not the 900 s default) reached both tokens.
    expect(issued.exp - issued.iat).toBe(600);
    expect(signed.exp - signed.iat).toBe(issued.exp - issued.iat);
    expect(issued).toMatchObject({ iss: 'parity-issuer', aud: 'parity-audience' });
  });
});

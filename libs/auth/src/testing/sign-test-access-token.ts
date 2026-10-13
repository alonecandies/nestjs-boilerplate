import { JwtService } from '@nestjs/jwt';
import { generateId } from '@platform/common';
import { type AuthConfig, authConfig } from '@platform/config';
import { JWT_ALGORITHM } from '../auth.constants.js';
import type { AccessTokenSubject, IssuedAccessToken } from '../types/auth-user.js';

export interface SignTestAccessTokenOptions {
  /**
   * Signing settings. Default: the `auth` namespace of `process.env`, i.e. what `AuthModule`
   * verifies with in a test app (the development secret unless the environment overrides it).
   */
  readonly config?: Pick<AuthConfig, 'accessSecret' | 'accessTtlSec' | 'issuer' | 'audience'>;
}

const jwt = new JwtService();

/**
 * TEST-ONLY: signs an access token exactly like the production issuer (HS256, `iss`/`aud`,
 * `typ: 'access'`, uuidv7 `jti`, `iat`/`exp` from one clock read), so platform and domain specs
 * can authenticate requests without depending on the domain that issues tokens. Production code
 * never imports `@platform/auth/testing`.
 */
export async function signTestAccessToken(
  claims: AccessTokenSubject,
  options: SignTestAccessTokenOptions = {},
): Promise<IssuedAccessToken> {
  const config = options.config ?? authConfig.parse();
  const iat = Math.floor(Date.now() / 1_000);
  const exp = iat + config.accessTtlSec;
  const jti = generateId();
  const payload = {
    sub: claims.id,
    email: claims.email,
    roles: [...claims.roles],
    typ: 'access',
    jti,
    iat,
    exp,
  };
  const token = await jwt.signAsync(payload, {
    secret: config.accessSecret,
    algorithm: JWT_ALGORITHM,
    issuer: config.issuer,
    audience: config.audience,
  });
  return { token, jti, expiresIn: config.accessTtlSec, exp };
}

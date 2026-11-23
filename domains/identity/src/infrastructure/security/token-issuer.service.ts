import { Inject, Injectable } from '@nestjs/common';
import { JwtService, type JwtSignOptions } from '@nestjs/jwt';
import {
  type AccessTokenSubject,
  AuthErrorCode,
  accessKeySet,
  type IssuedAccessToken,
  type IssuedRefreshToken,
  JWT_ALGORITHM,
  JWT_CLOCK_TOLERANCE_SEC,
  type JwtKeySet,
  jwtSigningKey,
  parseRefreshTokenClaims,
  type RefreshTokenClaims,
  resolveVerificationSecret,
  toUnauthenticated,
} from '@platform/auth';
import { generateId, UnauthenticatedException } from '@platform/common';
import { type AuthConfig, authConfig } from '@platform/config';
import { type RefreshTokenConfig, refreshTokenConfig } from './refresh-token.config.js';

const nowSec = (): number => Math.floor(Date.now() / 1_000);

/**
 * Signs identity's token pair and verifies refresh tokens (HS256, `kid` when the key has an id,
 * `iss`/`aud` checked, `typ` claim checked, uuidv7 `jti`). Access tokens use the platform `auth`
 * namespace (`JWT_ACCESS_*`, shared with every verifier: `TokenService`, `JwtStrategy`, the WS
 * helpers); refresh tokens use identity's own `refreshToken` namespace, which edge processes never
 * load. Each is a key set (SEC-1): the signing key writes new tokens, and refresh verification
 * picks the key with `resolveVerificationSecret`, as the access verifiers do. `iat`/`exp` are set
 * explicitly from one clock read so the returned `exp` is exactly the token's.
 */
@Injectable()
export class TokenIssuer {
  private readonly accessKeys: JwtKeySet;
  private readonly refreshKeys: JwtKeySet;

  constructor(
    private readonly jwt: JwtService,
    @Inject(authConfig.KEY) private readonly access: AuthConfig,
    @Inject(refreshTokenConfig.KEY) private readonly refresh: RefreshTokenConfig,
  ) {
    this.accessKeys = accessKeySet(access);
    this.refreshKeys = {
      signingSecret: refresh.refreshSecret,
      signingKeyId: refresh.refreshKeyId,
      verifyOnly: refresh.refreshVerifyKeys,
    };
  }

  /**
   * `options.ttlSec` shortens the lifetime (staff switch-in, Task 15); default `JWT_ACCESS_TTL_SEC`.
   * The `staff` claim is written only when true, so normal tokens carry no `staff` key.
   */
  async issueAccessToken(
    subject: AccessTokenSubject,
    options: { ttlSec?: number } = {},
  ): Promise<IssuedAccessToken> {
    const ttlSec = options.ttlSec ?? this.access.accessTtlSec;
    const iat = nowSec();
    const exp = iat + ttlSec;
    const jti = generateId();
    const payload = {
      sub: subject.id,
      email: subject.email,
      tid: subject.tenantId,
      roles: [...subject.roles],
      ...(subject.staff === true ? { staff: true } : {}),
      typ: 'access',
      jti,
      iat,
      exp,
    };
    const token = await this.jwt.signAsync(payload, this.signOptions(this.accessKeys));
    return { token, jti, expiresIn: ttlSec, exp };
  }

  /** `sessionId` becomes the `jti` (the sessions table stores sha256(token) under that id). */
  async issueRefreshToken(input: {
    userId: string;
    sessionId: string;
  }): Promise<IssuedRefreshToken> {
    const iat = nowSec();
    const exp = iat + this.refresh.refreshTtlSec;
    const payload = { sub: input.userId, jti: input.sessionId, typ: 'refresh', iat, exp };
    const token = await this.jwt.signAsync(payload, this.signOptions(this.refreshKeys));
    return { token, expiresAt: new Date(exp * 1_000) };
  }

  /** Throws `UnauthenticatedException` (`MISSING_TOKEN` / `TOKEN_EXPIRED` / `INVALID_TOKEN`). */
  async verifyRefreshToken(token: string): Promise<RefreshTokenClaims> {
    return parseRefreshTokenClaims(await this.verify(token));
  }

  private signOptions(keys: JwtKeySet): JwtSignOptions {
    return {
      ...jwtSigningKey(keys),
      algorithm: JWT_ALGORITHM,
      issuer: this.access.issuer,
      audience: this.access.audience,
    };
  }

  private async verify(token: string): Promise<unknown> {
    if (token.length === 0) {
      throw new UnauthenticatedException('Missing token', { code: AuthErrorCode.MISSING_TOKEN });
    }
    try {
      return await this.jwt.verifyAsync<Record<string, unknown>>(token, {
        secret: resolveVerificationSecret(token, this.refreshKeys),
        algorithms: [JWT_ALGORITHM],
        issuer: this.access.issuer,
        audience: this.access.audience,
        clockTolerance: JWT_CLOCK_TOLERANCE_SEC,
      });
    } catch (error) {
      throw toUnauthenticated(error);
    }
  }
}

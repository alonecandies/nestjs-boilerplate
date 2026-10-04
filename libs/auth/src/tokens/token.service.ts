import { generateId, UnauthenticatedException } from '@app/common';
import { type AuthConfig, authConfig } from '@app/config';
import { Inject, Injectable } from '@nestjs/common';
import { JwtService, type JwtSignOptions, type JwtVerifyOptions } from '@nestjs/jwt';
import { AuthErrorCode, JWT_ALGORITHM, JWT_CLOCK_TOLERANCE_SEC } from '../auth.constants.js';
import type {
  AccessTokenClaims,
  AccessTokenSubject,
  AuthUser,
  IssuedAccessToken,
  IssuedRefreshToken,
  RefreshTokenClaims,
} from '../types/auth-user.js';
import { parseAccessTokenClaims, parseRefreshTokenClaims, toAuthUser } from './token-claims.js';

const nowSec = (): number => Math.floor(Date.now() / 1_000);

/** Verification settings every verifier (TokenService, JwtStrategy, WS handshake) must share. */
export interface JwtVerificationSettings {
  algorithms: NonNullable<JwtVerifyOptions['algorithms']>;
  issuer: string;
  audience: string;
  /** Seconds. */
  clockTolerance: number;
}

/**
 * Maps jsonwebtoken failures to 401s with a stable code. Matched by `name` because
 * jsonwebtoken's error classes are not a dependency of this package.
 */
export function toUnauthenticated(error: unknown): UnauthenticatedException {
  if (error instanceof UnauthenticatedException) return error;
  const name = error instanceof Error ? error.name : '';
  if (name === 'TokenExpiredError') {
    return new UnauthenticatedException('Token has expired', {
      code: AuthErrorCode.TOKEN_EXPIRED,
      cause: error,
    });
  }
  return new UnauthenticatedException('Invalid token', {
    code: AuthErrorCode.INVALID_TOKEN,
    cause: error,
  });
}

/**
 * Issues and verifies JWTs (HS256, `iss`/`aud` checked, `typ` claim checked, uuidv7 `jti`).
 * Access and refresh tokens use SEPARATE secrets and TTLs (`JWT_*` env). `iat`/`exp` are set
 * explicitly from one clock read so the returned `exp` is exactly the token's.
 */
@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    @Inject(authConfig.KEY) private readonly config: AuthConfig,
  ) {}

  async issueAccessToken(user: AccessTokenSubject): Promise<IssuedAccessToken> {
    const iat = nowSec();
    const exp = iat + this.config.accessTtlSec;
    const jti = generateId();
    const payload = {
      sub: user.id,
      email: user.email,
      roles: [...user.roles],
      typ: 'access',
      jti,
      iat,
      exp,
    };
    const token = await this.jwt.signAsync(payload, this.signOptions(this.config.accessSecret));
    return { token, jti, expiresIn: this.config.accessTtlSec, exp };
  }

  /** `sessionId` becomes the `jti` (the sessions table stores sha256(token) under that id). */
  async issueRefreshToken(input: {
    userId: string;
    sessionId: string;
  }): Promise<IssuedRefreshToken> {
    const iat = nowSec();
    const exp = iat + this.config.refreshTtlSec;
    const payload = { sub: input.userId, jti: input.sessionId, typ: 'refresh', iat, exp };
    const token = await this.jwt.signAsync(payload, this.signOptions(this.config.refreshSecret));
    return { token, expiresAt: new Date(exp * 1_000) };
  }

  /** Throws `UnauthenticatedException` (`TOKEN_EXPIRED` / `INVALID_TOKEN`). Denylist NOT checked. */
  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    return parseAccessTokenClaims(await this.verify(token, this.config.accessSecret));
  }

  async verifyRefreshToken(token: string): Promise<RefreshTokenClaims> {
    return parseRefreshTokenClaims(await this.verify(token, this.config.refreshSecret));
  }

  toAuthUser(claims: AccessTokenClaims): AuthUser {
    return toAuthUser(claims);
  }

  /** What verifiers must enforce to accept exactly the tokens issued here. */
  get verificationSettings(): JwtVerificationSettings {
    return {
      algorithms: [JWT_ALGORITHM],
      issuer: this.config.issuer,
      audience: this.config.audience,
      clockTolerance: JWT_CLOCK_TOLERANCE_SEC,
    };
  }

  private signOptions(secret: string): JwtSignOptions {
    return {
      secret,
      algorithm: JWT_ALGORITHM,
      issuer: this.config.issuer,
      audience: this.config.audience,
    };
  }

  private async verify(token: string, secret: string): Promise<unknown> {
    if (token.length === 0) {
      throw new UnauthenticatedException('Missing token', { code: AuthErrorCode.MISSING_TOKEN });
    }
    try {
      return await this.jwt.verifyAsync<Record<string, unknown>>(token, {
        secret,
        ...this.verificationSettings,
      });
    } catch (error) {
      throw toUnauthenticated(error);
    }
  }
}

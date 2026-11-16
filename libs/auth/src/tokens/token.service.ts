import { Inject, Injectable } from '@nestjs/common';
import { JwtService, type JwtVerifyOptions } from '@nestjs/jwt';
import { UnauthenticatedException } from '@platform/common';
import { type AuthConfig, authConfig } from '@platform/config';
import { AuthErrorCode, JWT_ALGORITHM, JWT_CLOCK_TOLERANCE_SEC } from '../auth.constants.js';
import { RbacRegistry } from '../rbac/rbac.registry.js';
import type { AccessTokenClaims, AuthUser } from '../types/auth-user.js';
import { parseAccessTokenClaims, toAuthUser } from './token-claims.js';

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
 * Verifies access tokens locally, with no RPC per request: HS256 signature, `iss`/`aud`, `exp`
 * (5 s tolerance), then the `typ` claim. This package does not issue tokens: the bounded context
 * that owns sessions signs them with the shared `JWT_ACCESS_SECRET`, and tests sign them with
 * `signTestAccessToken` (`@platform/auth/testing`).
 */
@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    @Inject(authConfig.KEY) private readonly config: AuthConfig,
    private readonly rbac: RbacRegistry,
  ) {}

  /** Throws `UnauthenticatedException` (`TOKEN_EXPIRED` / `INVALID_TOKEN`). Denylist NOT checked. */
  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    return parseAccessTokenClaims(await this.verify(token));
  }

  toAuthUser(claims: AccessTokenClaims): AuthUser {
    return toAuthUser(claims, this.rbac.resolve(claims.roles));
  }

  /** What verifiers must enforce to accept exactly the tokens signed for this deployment. */
  get verificationSettings(): JwtVerificationSettings {
    return {
      algorithms: [JWT_ALGORITHM],
      issuer: this.config.issuer,
      audience: this.config.audience,
      clockTolerance: JWT_CLOCK_TOLERANCE_SEC,
    };
  }

  private async verify(token: string): Promise<unknown> {
    if (token.length === 0) {
      throw new UnauthenticatedException('Missing token', { code: AuthErrorCode.MISSING_TOKEN });
    }
    try {
      return await this.jwt.verifyAsync<Record<string, unknown>>(token, {
        secret: this.config.accessSecret,
        ...this.verificationSettings,
      });
    } catch (error) {
      throw toUnauthenticated(error);
    }
  }
}

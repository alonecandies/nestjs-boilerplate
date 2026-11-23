import { Inject, Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { UnauthenticatedException } from '@platform/common';
import { type AuthConfig, authConfig } from '@platform/config';
import { ExtractJwt, Strategy } from 'passport-jwt';
import {
  AuthErrorCode,
  JWT_ALGORITHM,
  JWT_CLOCK_TOLERANCE_SEC,
  JWT_STRATEGY,
} from '../auth.constants.js';
import { AccessTokenDenylist } from '../tokens/access-token-denylist.service.js';
import { accessKeySet, resolveVerificationSecret } from '../tokens/jwt-key-set.js';
import { TokenService } from '../tokens/token.service.js';
import { parseAccessTokenClaims } from '../tokens/token-claims.js';
import type { AuthUser } from '../types/auth-user.js';

/**
 * Passport `jwt` strategy: `Authorization: Bearer <access token>` verified LOCALLY (HS256
 * signature with the key `resolveVerificationSecret` picks, as `TokenService` does; `iss`, `aud`,
 * `exp` with 5 s tolerance — no RPC to the token issuer), then the `typ` claim, then the Redis
 * denylist. The returned `AuthUser` becomes `req.user`.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, JWT_STRATEGY) {
  constructor(
    @Inject(authConfig.KEY) config: AuthConfig,
    private readonly denylist: AccessTokenDenylist,
    private readonly tokens: TokenService,
  ) {
    const keys = accessKeySet(config);
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      // An unknown `kid` fails here with INVALID_TOKEN (passport hands it to the guard as `info`).
      secretOrKeyProvider: (_request: unknown, rawJwtToken: string, done) => {
        let secret: string;
        try {
          secret = resolveVerificationSecret(rawJwtToken, keys);
        } catch (error) {
          done(error);
          return;
        }
        done(null, secret);
      },
      algorithms: [JWT_ALGORITHM],
      issuer: config.issuer,
      audience: config.audience,
      ignoreExpiration: false,
      jsonWebTokenOptions: { clockTolerance: JWT_CLOCK_TOLERANCE_SEC },
    });
  }

  async validate(payload: unknown): Promise<AuthUser> {
    const claims = parseAccessTokenClaims(payload);
    if (await this.denylist.isDenied(claims.jti)) {
      throw new UnauthenticatedException('Token has been revoked', {
        code: AuthErrorCode.TOKEN_REVOKED,
      });
    }
    return this.tokens.toAuthUser(claims);
  }
}

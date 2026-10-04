import { UnauthenticatedException } from '@app/common';
import { type AuthConfig, authConfig } from '@app/config';
import { Inject, Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import {
  AuthErrorCode,
  JWT_ALGORITHM,
  JWT_CLOCK_TOLERANCE_SEC,
  JWT_STRATEGY,
} from '../auth.constants.js';
import { AccessTokenDenylist } from '../tokens/access-token-denylist.service.js';
import { parseAccessTokenClaims, toAuthUser } from '../tokens/token-claims.js';
import type { AuthUser } from '../types/auth-user.js';

/**
 * Passport `jwt` strategy: `Authorization: Bearer <access token>` verified LOCALLY (HS256
 * signature, `iss`, `aud`, `exp` with 5 s tolerance — no RPC to the identity service), then the
 * `typ` claim, then the Redis denylist. The returned `AuthUser` becomes `req.user`.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, JWT_STRATEGY) {
  constructor(
    @Inject(authConfig.KEY) config: AuthConfig,
    private readonly denylist: AccessTokenDenylist,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: config.accessSecret,
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
    return toAuthUser(claims);
  }
}

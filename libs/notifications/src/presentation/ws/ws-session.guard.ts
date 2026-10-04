import { AccessTokenDenylist, AuthErrorCode, isAuthUser } from '@app/auth';
import { getContextType, UnauthenticatedException } from '@app/common';
import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';

/** The part of a socket.io `Socket` read here. */
interface SocketLike {
  data?: { user?: unknown } | null;
}

/**
 * Per-message revocation check for the `/notifications` namespace. The handshake checks the
 * denylist once, and the global `JwtAuthGuard` only re-checks `exp` on each message. Without this
 * guard, a socket whose token was revoked by logout would keep getting its messages served until
 * the token expired, while HTTP rejects that token right away (`JwtStrategy` checks the denylist on
 * every request). Revoked → 401 `TOKEN_REVOKED`, like HTTP.
 *
 * Fails closed like HTTP: when Redis cannot answer, `isDenied` throws 503.
 */
@Injectable()
export class WsSessionGuard implements CanActivate {
  constructor(private readonly denylist: AccessTokenDenylist) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (getContextType(context) !== 'ws') return true;
    const user = context.switchToWs().getClient<SocketLike | undefined>()?.data?.user;
    // A missing user is JwtAuthGuard's call (MISSING_TOKEN); it runs first as a global guard.
    if (isAuthUser(user) && (await this.denylist.isDenied(user.jti))) {
      throw new UnauthenticatedException('Token has been revoked', {
        code: AuthErrorCode.TOKEN_REVOKED,
      });
    }
    return true;
  }
}

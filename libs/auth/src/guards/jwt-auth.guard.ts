import {
  getContextType,
  getRequest,
  IS_PUBLIC_KEY,
  type RequestLike,
  UnauthenticatedException,
} from '@app/common';
import { type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { firstValueFrom, isObservable } from 'rxjs';
import { AuthErrorCode, JWT_STRATEGY } from '../auth.constants.js';
import { isAuthUser } from '../tokens/token-claims.js';
import type { AuthUser } from '../types/auth-user.js';
import { passportFailure } from './auth-errors.js';

const missingToken = (): UnauthenticatedException =>
  new UnauthenticatedException('Missing bearer token', { code: AuthErrorCode.MISSING_TOKEN });

/**
 * Global authentication guard, transport-aware (hybrid apps run global guards everywhere):
 * - `rpc`: pass — gRPC/Kafka are internal; the edge already authenticated the caller.
 * - `@Public()`: pass (no token parsing at all).
 * - `ws`: the socket was authenticated once at the handshake (`authenticateSocket` →
 *   `socket.data.user`); here we only require that user and reject it once the token expired.
 * - `http` / `graphql`: passport `jwt` strategy on the request (`ctx.req` for GraphQL, including
 *   subscriptions whose request is synthesized from connection params).
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard(JWT_STRATEGY) {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  override async canActivate(context: ExecutionContext): Promise<boolean> {
    const type = getContextType(context);
    if (type === 'rpc' || this.isPublic(context)) return true;
    if (type === 'ws') return this.assertSocketUser(context);
    if (!this.getRequest(context)) {
      throw new UnauthenticatedException('Authentication required', {
        code: AuthErrorCode.MISSING_TOKEN,
      });
    }
    const result = super.canActivate(context);
    return isObservable(result) ? firstValueFrom(result) : result;
  }

  override getRequest(context: ExecutionContext): RequestLike | undefined {
    return getRequest<RequestLike>(context);
  }

  override handleRequest<TUser = AuthUser>(err: unknown, user: unknown, info: unknown): TUser {
    if (err || !user) throw passportFailure(err, info, missingToken);
    return user as TUser;
  }

  private isPublic(context: ExecutionContext): boolean {
    return (
      this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) === true
    );
  }

  private assertSocketUser(context: ExecutionContext): true {
    const user = getRequest<RequestLike>(context)?.user;
    if (!isAuthUser(user)) {
      throw new UnauthenticatedException('Socket is not authenticated', {
        code: AuthErrorCode.MISSING_TOKEN,
      });
    }
    // Long-lived sockets outlive their access token: stop serving messages once it expired.
    if (user.exp * 1_000 <= Date.now()) {
      throw new UnauthenticatedException('Token has expired', {
        code: AuthErrorCode.TOKEN_EXPIRED,
      });
    }
    return true;
  }
}

import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { getContextType, getPrincipal, getRequest, type RequestLike } from '@platform/common';
import type { Observable } from 'rxjs';
import { isAuthUser } from '../tokens/token-claims.js';
import { writePrincipal } from './principal-context.js';

/**
 * Writes the principal for Socket.IO messages and graphql-ws operations, whose CLS context
 * `RequestContextInterceptor` (@platform/observability) opens only after the guards ran. Registered
 * by `AuthModule` (global guards on); apps import ObservabilityModule first, so this runs inside that
 * context. Idempotent: an HTTP request already got its principal from `JwtAuthGuard`.
 */
@Injectable()
export class PrincipalContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (getContextType(context) !== 'rpc' && getPrincipal() === undefined) {
      const user = getRequest<RequestLike>(context)?.user;
      if (isAuthUser(user)) writePrincipal(user);
    }
    return next.handle();
  }
}

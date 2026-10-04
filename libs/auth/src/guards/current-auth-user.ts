import { getRequest, type RequestLike, UnauthenticatedException } from '@app/common';
import type { ExecutionContext } from '@nestjs/common';
import { isAuthUser } from '../tokens/token-claims.js';
import type { AuthUser } from '../types/auth-user.js';

/** `req.user` for authorization guards: 401 when a requirement exists but nobody is logged in. */
export function requireAuthUser(context: ExecutionContext): AuthUser {
  const user = getRequest<RequestLike>(context)?.user;
  if (!isAuthUser(user)) throw new UnauthenticatedException('Authentication required');
  return user;
}

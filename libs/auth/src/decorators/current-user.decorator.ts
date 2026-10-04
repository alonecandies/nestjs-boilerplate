import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { requireAuthUser } from '../guards/current-auth-user.js';
import type { AuthUser } from '../types/auth-user.js';

/**
 * `@CurrentUser() user: AuthUser` or `@CurrentUser('id') userId: string`. Works for every
 * transport through `getRequest()` (WS reads `socket.data.user`). Throws 401 when there is no
 * user — on `@Public()` routes, read `req.user` yourself if authentication is optional.
 */
export const CurrentUser: (field?: keyof AuthUser) => ParameterDecorator = createParamDecorator(
  (field: keyof AuthUser | undefined, context: ExecutionContext): unknown => {
    const user = requireAuthUser(context);
    return field === undefined ? user : user[field];
  },
);

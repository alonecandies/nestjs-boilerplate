import { UnauthenticatedException } from '@app/common';
import { type ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { firstValueFrom, isObservable } from 'rxjs';
import { LOCAL_STRATEGY } from '../auth.constants.js';
import { passportFailure } from './auth-errors.js';

/** The strategy returned no user without throwing (identity normally throws its own 401). */
const invalidCredentials = (): UnauthenticatedException =>
  new UnauthenticatedException('Invalid credentials', { code: 'INVALID_CREDENTIALS' });

/**
 * `@UseGuards(LocalAuthGuard)` on the HTTP login route (`@Public()`): runs the `local` passport
 * strategy (email + password from the body), which @app/identity implements (`LocalStrategy`).
 * Failures surface as our 401s instead of passport's bare `UnauthorizedException`.
 */
@Injectable()
export class LocalAuthGuard extends AuthGuard(LOCAL_STRATEGY) {
  override async canActivate(context: ExecutionContext): Promise<boolean> {
    const result = super.canActivate(context);
    return isObservable(result) ? firstValueFrom(result) : result;
  }

  override handleRequest<TUser = unknown>(err: unknown, user: unknown, info: unknown): TUser {
    if (err || !user) throw passportFailure(err, info, invalidCredentials);
    return user as TUser;
  }
}

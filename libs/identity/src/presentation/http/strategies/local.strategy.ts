import { LOCAL_STRATEGY } from '@app/auth';
import type { RequestLike } from '@app/common';
import type { AuthTokens } from '@app/contracts';
import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-local';
import { AuthPort } from '../../../application/ports/auth.port.js';
import { clientInfoOf } from '../../shared/client-info.util.js';

/**
 * passport-local strategy behind `LocalAuthGuard` (@app/auth) on `POST /v1/auth/login`: email +
 * password from the (already validated, see `LoginRequestGuard`) body → `AuthPort.login`. The
 * resulting token pair becomes `req.user`. Failures are our `InvalidCredentialsException`
 * (a DomainException), which LocalAuthGuard passes through unchanged.
 */
@Injectable()
export class LocalStrategy extends PassportStrategy(Strategy, LOCAL_STRATEGY) {
  constructor(private readonly auth: AuthPort) {
    super({
      usernameField: 'email',
      passwordField: 'password',
      passReqToCallback: true,
      session: false,
    });
  }

  validate(request: RequestLike, email: string, password: string): Promise<AuthTokens> {
    return this.auth.login({ email, password, client: clientInfoOf(request) });
  }
}

import type { AuthTokens } from '@domain/identity-contracts';
import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { LOCAL_STRATEGY } from '@platform/auth';
import type { RequestLike } from '@platform/common';
import { Strategy } from 'passport-local';
import { AuthPort } from '../../../application/ports/auth.port.js';
import { clientInfoOf } from '../../shared/client-info.util.js';

/**
 * passport-local strategy behind `LocalAuthGuard` (@platform/auth) on `POST /v1/auth/login`: email +
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

  validate(
    request: RequestLike & { body?: unknown },
    email: string,
    password: string,
  ): Promise<AuthTokens> {
    // passport-local hands over only the two credential fields; the tenant comes from the body that
    // LoginRequestGuard has already validated (a UUID or absent).
    const { tenantId } = (request.body ?? {}) as { tenantId?: string };
    return this.auth.login({
      email,
      password,
      client: clientInfoOf(request),
      ...(tenantId === undefined ? {} : { tenantId }),
    });
  }
}

import { Args, Context, Mutation, Resolver } from '@nestjs/graphql';
import { Public } from '@platform/common';
import type { GqlContext } from '@platform/graphql';
import { RateLimit } from '@platform/redis';
import { AuthPort } from '../../application/ports/auth.port.js';
import { IDENTITY_RATE_LIMITS } from '../rate-limit/identity-rate-limit.js';
import { clientInfoOf } from '../shared/client-info.util.js';
import { toAuthPayloadModel } from './graphql.mapper.js';
import { LoginInput } from './inputs/login.input.js';
import { RefreshTokensInput } from './inputs/refresh-tokens.input.js';
import { RegisterInput } from './inputs/register.input.js';
import { AuthPayloadModel } from './models/auth-payload.model.js';

/**
 * Credential mutations. Login calls `AuthPort.login` directly (passport-local is an HTTP-body
 * strategy); the error model is identical (`INVALID_CREDENTIALS` in `extensions.code`).
 * `identity.credentials` (shared with REST) applies because the throttler guard throttles GraphQL too.
 */
@Resolver(() => AuthPayloadModel)
export class AuthResolver {
  constructor(private readonly auth: AuthPort) {}

  @Mutation(() => AuthPayloadModel, { description: 'Create an account and open a session' })
  @Public()
  @RateLimit(IDENTITY_RATE_LIMITS.CREDENTIALS)
  async register(
    @Args('input') input: RegisterInput,
    @Context() context: GqlContext,
  ): Promise<AuthPayloadModel> {
    const tokens = await this.auth.register({
      email: input.email,
      password: input.password,
      displayName: input.displayName,
      client: clientInfoOf(context.req),
    });
    return toAuthPayloadModel(tokens);
  }

  @Mutation(() => AuthPayloadModel, { description: 'Log in with email + password' })
  @Public()
  @RateLimit(IDENTITY_RATE_LIMITS.CREDENTIALS)
  async login(
    @Args('input') input: LoginInput,
    @Context() context: GqlContext,
  ): Promise<AuthPayloadModel> {
    const tokens = await this.auth.login({
      email: input.email,
      password: input.password,
      client: clientInfoOf(context.req),
      ...(input.tenantId === undefined || input.tenantId === null
        ? {}
        : { tenantId: input.tenantId }),
    });
    return toAuthPayloadModel(tokens);
  }

  @Mutation(() => AuthPayloadModel, {
    description: 'Rotate the refresh token (reusing a rotated token revokes every session)',
  })
  @Public()
  async refreshTokens(
    @Args('input') input: RefreshTokensInput,
    @Context() context: GqlContext,
  ): Promise<AuthPayloadModel> {
    const tokens = await this.auth.refreshTokens({
      refreshToken: input.refreshToken,
      client: clientInfoOf(context.req),
    });
    return toAuthPayloadModel(tokens);
  }
}

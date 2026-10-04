import { Public } from '@app/common';
import type { GqlContext } from '@app/graphql';
import { AuthThrottle } from '@app/redis';
import { Args, Context, Mutation, Resolver } from '@nestjs/graphql';
import { AuthPort } from '../../application/ports/auth.port.js';
import { clientInfoOf } from '../shared/client-info.util.js';
import { toAuthPayloadModel } from './graphql.mapper.js';
import { LoginInput } from './inputs/login.input.js';
import { RefreshTokensInput } from './inputs/refresh-tokens.input.js';
import { RegisterInput } from './inputs/register.input.js';
import { AuthPayloadModel } from './models/auth-payload.model.js';

/**
 * Credential mutations. Login calls `AuthPort.login` directly (passport-local is an HTTP-body
 * strategy); the error model is identical (`INVALID_CREDENTIALS` in `extensions.code`).
 * `@AuthThrottle` applies because the throttler guard throttles GraphQL too.
 */
@Resolver(() => AuthPayloadModel)
export class AuthResolver {
  constructor(private readonly auth: AuthPort) {}

  @Mutation(() => AuthPayloadModel, { description: 'Create an account and open a session' })
  @Public()
  @AuthThrottle()
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
  @AuthThrottle()
  async login(
    @Args('input') input: LoginInput,
    @Context() context: GqlContext,
  ): Promise<AuthPayloadModel> {
    const tokens = await this.auth.login({
      email: input.email,
      password: input.password,
      client: clientInfoOf(context.req),
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

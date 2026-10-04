import { type AuthUser, CurrentUser, LocalAuthGuard } from '@app/auth';
import { Public, type RequestLike } from '@app/common';
import type { AuthTokens } from '@app/contracts';
import { AuthThrottle } from '@app/redis';
import {
  Body,
  ClassSerializerInterceptor,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthPort } from '../../application/ports/auth.port.js';
import { clientInfoOf } from '../shared/client-info.util.js';
import { UserReadCache } from '../shared/user-read.cache.js';
import { LoginDto } from './dto/login.dto.js';
import { LogoutDto } from './dto/logout.dto.js';
import { RefreshTokenDto } from './dto/refresh-token.dto.js';
import { RegisterDto } from './dto/register.dto.js';
import { LoginRequestGuard } from './guards/login-request.guard.js';
import { AuthTokensResponse } from './responses/auth-tokens.response.js';
import { ProblemResponse } from './responses/problem.response.js';
import { UserResponse } from './responses/user.response.js';

/** `req.user` after `LocalAuthGuard`: the token pair produced by `LocalStrategy`. */
interface AuthenticatedLoginRequest extends RequestLike {
  user: AuthTokens;
}

@ApiTags('auth')
@Controller({ path: 'auth', version: '1' })
// Controller-scoped (HTTP only): a global ClassSerializerInterceptor would also walk GraphQL
// subscription iterators (research nest-http GOTCHA 1).
@UseInterceptors(ClassSerializerInterceptor)
export class AuthController {
  constructor(
    private readonly auth: AuthPort,
    private readonly users: UserReadCache,
  ) {}

  @Post('register')
  @Public()
  @AuthThrottle()
  @ApiOperation({ summary: 'Create an account and open a session' })
  @ApiCreatedResponse({ type: AuthTokensResponse })
  @ApiBadRequestResponse({ type: ProblemResponse, description: 'Invalid body (`errors`).' })
  @ApiConflictResponse({ type: ProblemResponse, description: '`EMAIL_TAKEN`' })
  @ApiTooManyRequestsResponse({ type: ProblemResponse })
  async register(
    @Body() body: RegisterDto,
    @Req() request: RequestLike,
  ): Promise<AuthTokensResponse> {
    const tokens = await this.auth.register({
      email: body.email,
      password: body.password,
      displayName: body.displayName,
      client: clientInfoOf(request),
    });
    return AuthTokensResponse.from(tokens);
  }

  @Post('login')
  @Public()
  @AuthThrottle()
  @HttpCode(HttpStatus.OK)
  @UseGuards(LoginRequestGuard, LocalAuthGuard)
  @ApiOperation({ summary: 'Log in with email + password (passport-local)' })
  @ApiBody({ type: LoginDto })
  @ApiOkResponse({ type: AuthTokensResponse })
  @ApiBadRequestResponse({ type: ProblemResponse, description: 'Invalid body (`errors`).' })
  @ApiUnauthorizedResponse({ type: ProblemResponse, description: '`INVALID_CREDENTIALS`' })
  @ApiTooManyRequestsResponse({ type: ProblemResponse })
  login(@Req() request: AuthenticatedLoginRequest): AuthTokensResponse {
    return AuthTokensResponse.from(request.user);
  }

  @Post('refresh')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Rotate the refresh token',
    description:
      'Returns a new token pair and revokes the presented refresh token. Presenting an already ' +
      'rotated token revokes every session of the user (`REFRESH_TOKEN_REUSED`).',
  })
  @ApiOkResponse({ type: AuthTokensResponse })
  @ApiBadRequestResponse({ type: ProblemResponse })
  @ApiUnauthorizedResponse({
    type: ProblemResponse,
    description: '`INVALID_REFRESH_TOKEN`, `SESSION_EXPIRED` or `REFRESH_TOKEN_REUSED`',
  })
  async refresh(
    @Body() body: RefreshTokenDto,
    @Req() request: RequestLike,
  ): Promise<AuthTokensResponse> {
    const tokens = await this.auth.refreshTokens({
      refreshToken: body.refreshToken,
      client: clientInfoOf(request),
    });
    return AuthTokensResponse.from(tokens);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Log out',
    description:
      'Revokes the access token immediately (denylist) and the session of `refreshToken`, or ' +
      'every session of the user when it is omitted.',
  })
  @ApiNoContentResponse()
  @ApiUnauthorizedResponse({ type: ProblemResponse })
  async logout(@Body() body: LogoutDto, @CurrentUser() user: AuthUser): Promise<void> {
    await this.auth.logout({
      userId: user.id,
      accessTokenJti: user.jti,
      accessTokenExp: String(user.exp),
      refreshToken: body.refreshToken,
    });
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'The authenticated user' })
  @ApiOkResponse({ type: UserResponse })
  @ApiUnauthorizedResponse({ type: ProblemResponse })
  async me(@CurrentUser('id') userId: string): Promise<UserResponse> {
    return UserResponse.from(await this.users.getUser(userId));
  }
}

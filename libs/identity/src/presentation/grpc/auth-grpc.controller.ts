import {
  type AuthServiceController,
  AuthServiceControllerMethods,
  type AuthTokens,
  type LoginRequest,
  type LogoutRequest,
  type RefreshTokensRequest,
  type RegisterRequest,
} from '@app/contracts';
import { GrpcController, ZodRpcValidationPipe } from '@app/transport';
import { CommandBus } from '@nestjs/cqrs';
import { Payload } from '@nestjs/microservices';
import {
  toLoginCommand,
  toLogoutCommand,
  toRefreshSessionCommand,
  toRegisterUserCommand,
} from '../../application/mappers/identity-request.mapper.js';
import {
  loginRequestSchema,
  logoutRequestSchema,
  refreshTokensRequestSchema,
  registerRequestSchema,
} from './identity-rpc.payloads.js';

/**
 * `identity.v1.AuthService` (identity-service). `@GrpcController()` scopes the DomainException →
 * gRPC status filter and the metadata → CLS interceptor to this controller; payloads are
 * validated with zod (`INVALID_ARGUMENT` + issues). Handlers are the same commands the monolith
 * dispatches in-process.
 */
@GrpcController()
@AuthServiceControllerMethods()
export class AuthGrpcController implements AuthServiceController {
  constructor(private readonly commandBus: CommandBus) {}

  register(
    @Payload(new ZodRpcValidationPipe(registerRequestSchema)) request: RegisterRequest,
  ): Promise<AuthTokens> {
    return this.commandBus.execute(toRegisterUserCommand(request));
  }

  login(
    @Payload(new ZodRpcValidationPipe(loginRequestSchema)) request: LoginRequest,
  ): Promise<AuthTokens> {
    return this.commandBus.execute(toLoginCommand(request));
  }

  refreshTokens(
    @Payload(new ZodRpcValidationPipe(refreshTokensRequestSchema)) request: RefreshTokensRequest,
  ): Promise<AuthTokens> {
    return this.commandBus.execute(toRefreshSessionCommand(request));
  }

  /** Resolves `undefined`, which serialises as `google.protobuf.Empty`. */
  logout(
    @Payload(new ZodRpcValidationPipe(logoutRequestSchema)) request: LogoutRequest,
  ): Promise<void> {
    return this.commandBus.execute(toLogoutCommand(request));
  }
}

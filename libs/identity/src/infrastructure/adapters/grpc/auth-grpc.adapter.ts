import {
  AUTH_SERVICE_NAME,
  type AuthServiceClient,
  type AuthTokens,
  GRPC_PACKAGES,
  type LoginRequest,
  type LogoutRequest,
  type RefreshTokensRequest,
  type RegisterRequest,
} from '@app/contracts';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { ClientGrpc } from '@nestjs/microservices';
import type { AuthPort } from '../../../application/ports/auth.port.js';
import { normalizeAuthTokens } from './grpc-contract.normalizer.js';
import { IdentityGrpcCaller } from './identity-grpc.caller.js';

const operation = (method: string): string => `identity.v1.${AUTH_SERVICE_NAME}/${method}`;

/** Gateway binding of `AuthPort`: `identity.v1.AuthService` over gRPC. */
@Injectable()
export class AuthGrpcAdapter implements AuthPort, OnModuleInit {
  private auth: AuthServiceClient;

  constructor(
    @Inject(GRPC_PACKAGES.identity.clientToken) private readonly client: ClientGrpc,
    private readonly caller: IdentityGrpcCaller,
  ) {}

  onModuleInit(): void {
    this.auth = this.client.getService<AuthServiceClient>(AUTH_SERVICE_NAME);
  }

  async register(input: RegisterRequest): Promise<AuthTokens> {
    const tokens = await this.caller.call(operation('Register'), (metadata) =>
      this.auth.register(input, metadata),
    );
    return normalizeAuthTokens(tokens);
  }

  async login(input: LoginRequest): Promise<AuthTokens> {
    const tokens = await this.caller.call(operation('Login'), (metadata) =>
      this.auth.login(input, metadata),
    );
    return normalizeAuthTokens(tokens);
  }

  async refreshTokens(input: RefreshTokensRequest): Promise<AuthTokens> {
    const tokens = await this.caller.call(operation('RefreshTokens'), (metadata) =>
      this.auth.refreshTokens(input, metadata),
    );
    return normalizeAuthTokens(tokens);
  }

  async logout(input: LogoutRequest): Promise<void> {
    await this.caller.call(operation('Logout'), (metadata) => this.auth.logout(input, metadata));
  }
}

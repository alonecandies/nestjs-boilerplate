import {
  AUTH_SERVICE_NAME,
  type AuthServiceClient,
  type AuthTokens,
  IDENTITY_GRPC_PACKAGE,
  type LoginRequest,
  type LogoutRequest,
  type RefreshTokensRequest,
  type RegisterRequest,
  type StaffAccessToken,
  type StaffSwitchInRequest,
  type StaffSwitchOutRequest,
  type SwitchTenantRequest,
} from '@domain/identity-contracts';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { ClientGrpc } from '@nestjs/microservices';
import type { AuthPort } from '../../../application/ports/auth.port.js';
import { normalizeAuthTokens, normalizeStaffAccessToken } from './grpc-contract.normalizer.js';
import { IdentityGrpcCaller } from './identity-grpc.caller.js';

const operation = (method: string): string => `identity.v1.${AUTH_SERVICE_NAME}/${method}`;

/** Gateway binding of `AuthPort`: `identity.v1.AuthService` over gRPC. */
@Injectable()
export class AuthGrpcAdapter implements AuthPort, OnModuleInit {
  private auth: AuthServiceClient;

  constructor(
    @Inject(IDENTITY_GRPC_PACKAGE.clientToken) private readonly client: ClientGrpc,
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

  async switchTenant(input: SwitchTenantRequest): Promise<AuthTokens> {
    const tokens = await this.caller.call(operation('SwitchTenant'), (metadata) =>
      this.auth.switchTenant(input, metadata),
    );
    return normalizeAuthTokens(tokens);
  }

  async staffSwitchIn(input: StaffSwitchInRequest): Promise<StaffAccessToken> {
    const token = await this.caller.call(operation('StaffSwitchIn'), (metadata) =>
      this.auth.staffSwitchIn(input, metadata),
    );
    return normalizeStaffAccessToken(token);
  }

  async staffSwitchOut(input: StaffSwitchOutRequest): Promise<void> {
    await this.caller.call(operation('StaffSwitchOut'), (metadata) =>
      this.auth.staffSwitchOut(input, metadata),
    );
  }
}

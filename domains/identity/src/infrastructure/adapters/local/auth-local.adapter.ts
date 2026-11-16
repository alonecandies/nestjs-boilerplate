import type {
  AuthTokens,
  LoginRequest,
  LogoutRequest,
  RefreshTokensRequest,
  RegisterRequest,
  SwitchTenantRequest,
} from '@domain/identity-contracts';
import { Injectable } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import {
  toLoginCommand,
  toLogoutCommand,
  toRefreshSessionCommand,
  toRegisterUserCommand,
  toSwitchTenantCommand,
} from '../../../application/mappers/identity-request.mapper.js';
import type { AuthPort } from '../../../application/ports/auth.port.js';

/** Monolith binding of `AuthPort`: in-process CommandBus (no serialisation, no network). */
@Injectable()
export class AuthLocalAdapter implements AuthPort {
  constructor(private readonly commandBus: CommandBus) {}

  register(input: RegisterRequest): Promise<AuthTokens> {
    return this.commandBus.execute(toRegisterUserCommand(input));
  }

  login(input: LoginRequest): Promise<AuthTokens> {
    return this.commandBus.execute(toLoginCommand(input));
  }

  refreshTokens(input: RefreshTokensRequest): Promise<AuthTokens> {
    return this.commandBus.execute(toRefreshSessionCommand(input));
  }

  logout(input: LogoutRequest): Promise<void> {
    return this.commandBus.execute(toLogoutCommand(input));
  }

  switchTenant(input: SwitchTenantRequest): Promise<AuthTokens> {
    return this.commandBus.execute(toSwitchTenantCommand(input));
  }
}

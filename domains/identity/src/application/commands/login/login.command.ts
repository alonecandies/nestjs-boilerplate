import type { AuthTokens, ClientInfo } from '@domain/identity-contracts';
import { Command } from '@nestjs/cqrs';

/** Verifies email + password and opens a session in `tenantId` (default: the most recently active membership). */
export class LoginCommand extends Command<AuthTokens> {
  constructor(
    readonly email: string,
    readonly password: string,
    readonly client?: ClientInfo | undefined,
    readonly tenantId?: string | undefined,
  ) {
    super();
  }
}

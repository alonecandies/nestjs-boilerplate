import { Command } from '@nestjs/cqrs';
import type { AuthTokens, ClientInfo } from '@platform/contracts';

/** Verifies email + password and opens a new session. */
export class LoginCommand extends Command<AuthTokens> {
  constructor(
    readonly email: string,
    readonly password: string,
    readonly client?: ClientInfo | undefined,
  ) {
    super();
  }
}

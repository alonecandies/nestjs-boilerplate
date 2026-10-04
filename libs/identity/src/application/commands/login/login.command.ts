import type { AuthTokens, ClientInfo } from '@app/contracts';
import { Command } from '@nestjs/cqrs';

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

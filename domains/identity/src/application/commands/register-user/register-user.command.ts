import { Command } from '@nestjs/cqrs';
import type { AuthTokens, ClientInfo } from '@platform/contracts';

/** Creates an account (default role `user`) and opens its first session. */
export class RegisterUserCommand extends Command<AuthTokens> {
  constructor(
    readonly email: string,
    readonly password: string,
    readonly displayName: string,
    readonly client?: ClientInfo | undefined,
  ) {
    super();
  }
}

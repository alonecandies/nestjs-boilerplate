import type { AuthTokens, ClientInfo } from '@app/contracts';
import { Command } from '@nestjs/cqrs';

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

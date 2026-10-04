import type { AuthTokens, ClientInfo } from '@app/contracts';
import { Command } from '@nestjs/cqrs';

/** Rotates a refresh token: revokes its session and opens the successor (reuse detection). */
export class RefreshSessionCommand extends Command<AuthTokens> {
  constructor(
    readonly refreshToken: string,
    readonly client?: ClientInfo | undefined,
  ) {
    super();
  }
}

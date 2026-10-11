import { Command } from '@nestjs/cqrs';

/**
 * Denylists the access token (`jti` until `exp`) and revokes the session bound to
 * `refreshToken` — or all sessions of the user when it is omitted.
 */
export class LogoutCommand extends Command<void> {
  constructor(
    readonly userId: string,
    readonly accessTokenJti: string,
    /** Epoch seconds. */
    readonly accessTokenExp: number,
    readonly refreshToken?: string | undefined,
  ) {
    super();
  }
}

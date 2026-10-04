import { AccessTokenDenylist, TokenService } from '@app/auth';
import { Logger } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { SessionsRepository } from '../../persistence/sessions.repository.js';
import { LogoutCommand } from './logout.command.js';

@CommandHandler(LogoutCommand)
export class LogoutHandler implements ICommandHandler<LogoutCommand> {
  private readonly logger = new Logger(LogoutHandler.name);

  constructor(
    private readonly denylist: AccessTokenDenylist,
    private readonly tokens: TokenService,
    private readonly sessions: SessionsRepository,
  ) {}

  async execute(command: LogoutCommand): Promise<void> {
    const now = new Date();
    // Access tokens are verified locally at the edge (no RPC per request), so revocation is a
    // Redis denylist entry that lives exactly as long as the token could still be accepted.
    await this.denylist.deny(command.accessTokenJti, command.accessTokenExp);

    if (command.refreshToken === undefined) {
      const revoked = await this.sessions.revokeAllForUser(command.userId, now);
      this.logger.debug({ userId: command.userId, revoked }, 'Signed out of every session');
      return;
    }
    const sessionId = await this.sessionIdOf(command.refreshToken, command.userId);
    if (sessionId !== undefined) {
      await this.sessions.revoke({ id: sessionId, userId: command.userId, now });
    }
  }

  /**
   * Logout is idempotent and lenient: an expired, foreign or garbage refresh token revokes
   * nothing (the access token is denylisted regardless) instead of failing the request.
   */
  private async sessionIdOf(refreshToken: string, userId: string): Promise<string | undefined> {
    try {
      const claims = await this.tokens.verifyRefreshToken(refreshToken);
      return claims.sub === userId ? claims.jti : undefined;
    } catch {
      return undefined;
    }
  }
}

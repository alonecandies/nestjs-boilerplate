import { AuthErrorCode, type RefreshTokenClaims, TokenService } from '@app/auth';
import { type DomainException, generateId, sha256Hex, UnauthenticatedException } from '@app/common';
import type { AuthTokens } from '@app/contracts';
import { Logger } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import {
  InvalidRefreshTokenException,
  RefreshTokenReuseDetectedException,
  SessionExpiredException,
} from '../../../domain/identity.errors.js';
import { classifyRefreshRejection } from '../../../domain/session.js';
import { SessionsRepository } from '../../persistence/sessions.repository.js';
import { TransactionRunner } from '../../persistence/transaction-runner.js';
import { UsersRepository } from '../../persistence/users.repository.js';
import { SessionTokensService } from '../../services/session-tokens.service.js';
import { RefreshSessionCommand } from './refresh-session.command.js';

/**
 * Refresh-token rotation with reuse detection (blueprint §2.4):
 * 1. verify the JWT (signature, iss/aud, exp, `typ: refresh`) — no DB access for garbage;
 * 2. in ONE transaction: conditionally revoke the presented session (active + same user + same
 *    sha256) and insert its successor — two concurrent refreshes of one token cannot both win;
 * 3. if nothing was revoked, find out why. A genuine but already-revoked token means a rotated
 *    token came back (stolen copy or replay): every session of the user is revoked. That
 *    revocation runs OUTSIDE the rotation transaction, so throwing afterwards cannot roll it back.
 */
@CommandHandler(RefreshSessionCommand)
export class RefreshSessionHandler implements ICommandHandler<RefreshSessionCommand> {
  private readonly logger = new Logger(RefreshSessionHandler.name);

  constructor(
    private readonly tokens: TokenService,
    private readonly users: UsersRepository,
    private readonly sessions: SessionsRepository,
    private readonly sessionTokens: SessionTokensService,
    private readonly transaction: TransactionRunner,
  ) {}

  async execute(command: RefreshSessionCommand): Promise<AuthTokens> {
    const claims = await this.verify(command.refreshToken);
    const refreshTokenHash = sha256Hex(command.refreshToken);
    const now = new Date();

    // Fresh roles/email for the new access token (role changes apply from the next refresh).
    const user = await this.users.findById(claims.sub);
    if (!user) throw new InvalidRefreshTokenException();

    const successorId = generateId();
    const tokens = await this.transaction.run(async () => {
      const rotated = await this.sessions.revokeForRotation({
        id: claims.jti,
        userId: claims.sub,
        refreshTokenHash,
        replacedById: successorId,
        now,
      });
      return rotated ? this.sessionTokens.open(user, command.client, successorId) : undefined;
    });
    if (tokens) return tokens;
    throw await this.rejection(claims, refreshTokenHash, now);
  }

  private async verify(token: string): Promise<RefreshTokenClaims> {
    try {
      return await this.tokens.verifyRefreshToken(token);
    } catch (error) {
      if (error instanceof UnauthenticatedException && error.code === AuthErrorCode.TOKEN_EXPIRED) {
        throw new SessionExpiredException({ cause: error });
      }
      throw new InvalidRefreshTokenException({ cause: error });
    }
  }

  private async rejection(
    claims: RefreshTokenClaims,
    refreshTokenHash: string,
    now: Date,
  ): Promise<DomainException> {
    const session = await this.sessions.findById(claims.jti);
    const reason = classifyRefreshRejection(session, {
      userId: claims.sub,
      refreshTokenHash,
      now,
    });
    switch (reason) {
      case 'reused': {
        const revoked = await this.sessions.revokeAllForUser(claims.sub, now);
        this.logger.warn(
          { userId: claims.sub, sessionId: claims.jti, revokedSessions: revoked },
          'Refresh token reuse detected: all sessions of the user revoked',
        );
        return new RefreshTokenReuseDetectedException();
      }
      case 'expired':
        return new SessionExpiredException();
      case 'invalid':
        return new InvalidRefreshTokenException();
    }
  }
}

import type { AuthTokens } from '@domain/identity-contracts';
import { Logger } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { AuthErrorCode, type RefreshTokenClaims } from '@platform/auth';
import {
  type DomainException,
  generateId,
  sha256Hex,
  timingSafeEqualStr,
  UnauthenticatedException,
} from '@platform/common';
import {
  InvalidRefreshTokenException,
  MembershipRevokedException,
  RefreshTokenReuseDetectedException,
  SessionExpiredException,
} from '../../../domain/identity.errors.js';
import { classifyRefreshRejection, isSessionActive } from '../../../domain/session.js';
import { TokenIssuer } from '../../../infrastructure/security/token-issuer.service.js';
import { MembershipsRepository } from '../../persistence/memberships.repository.js';
import { SessionsRepository } from '../../persistence/sessions.repository.js';
import { TransactionRunner } from '../../persistence/transaction-runner.js';
import { UsersRepository } from '../../persistence/users.repository.js';
import { SessionTokensService } from '../../services/session-tokens.service.js';
import { RefreshSessionCommand } from './refresh-session.command.js';

/**
 * Refresh-token rotation with reuse detection (blueprint §2.4):
 * 1. verify the JWT (signature, iss/aud, exp, `typ: refresh`) — no DB access for garbage;
 * 2. read the session (its tenant and the membership's roles), then in ONE transaction
 *    conditionally revoke it and insert its successor in the same tenant (active + same user + same
 *    sha256) — two concurrent refreshes of one token cannot both win;
 * 3. if nothing was revoked, find out why. A genuine but already-revoked token means a rotated
 *    token came back (stolen copy or replay): every session of the user is revoked. That
 *    revocation runs OUTSIDE the rotation transaction, so throwing afterwards cannot roll it back.
 */
@CommandHandler(RefreshSessionCommand)
export class RefreshSessionHandler implements ICommandHandler<RefreshSessionCommand> {
  private readonly logger = new Logger(RefreshSessionHandler.name);

  constructor(
    private readonly tokens: TokenIssuer,
    private readonly users: UsersRepository,
    private readonly sessions: SessionsRepository,
    private readonly sessionTokens: SessionTokensService,
    private readonly transaction: TransactionRunner,
    private readonly memberships: MembershipsRepository,
  ) {}

  async execute(command: RefreshSessionCommand): Promise<AuthTokens> {
    const claims = await this.verify(command.refreshToken);
    const refreshTokenHash = sha256Hex(command.refreshToken);
    const now = new Date();

    // Fresh email for the new access token; roles come from the session tenant's membership.
    const user = await this.users.findById(claims.sub);
    if (!user) throw new InvalidRefreshTokenException();

    // The session row decides the tenant (spec §5.2: refresh keeps it). Router query on Citus.
    const session = await this.sessions.findById(claims.sub, claims.jti);
    if (
      session !== null &&
      isSessionActive(session, now) &&
      timingSafeEqualStr(session.refreshTokenHash, refreshTokenHash)
    ) {
      const membership = await this.memberships.find(session.tenantId, user.id);
      if (membership === null) {
        await this.sessions.revoke({ id: session.id, userId: user.id, now });
        throw new MembershipRevokedException();
      }
      const successorId = generateId();
      const tokens = await this.transaction.run(async () => {
        const rotated = await this.sessions.revokeForRotation({
          id: claims.jti,
          userId: claims.sub,
          refreshTokenHash,
          replacedById: successorId,
          now,
        });
        return rotated
          ? this.sessionTokens.open({
              user,
              tenantId: session.tenantId,
              roles: membership.roles,
              client: command.client,
              sessionId: successorId,
            })
          : undefined;
      });
      if (tokens) return tokens;
    }
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
    const session = await this.sessions.findById(claims.sub, claims.jti);
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

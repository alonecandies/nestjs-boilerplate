import type { AuthTokens } from '@domain/identity-contracts';
import { Logger } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { AuthErrorCode, type RefreshTokenClaims } from '@platform/auth';
import {
  createPrincipal,
  type DomainException,
  generateId,
  type Principal,
  runWithPrincipal,
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
 * Refresh-token rotation with reuse detection (blueprint §2.4; plan B3 Task 12 flow table):
 * 1. verify the JWT (signature, iss/aud, exp, `typ: refresh`) — no DB access for garbage;
 * 2. as `{ sub, null }`, in ONE read transaction (one BEGIN/COMMIT and pool checkout, not one per
 *    read): read the user, the session by `(sub, jti)` and the membership of the session's tenant
 *    (its roles become the principal's);
 * 3. ONE unit of work as `{ sub, session.tenantId, roles }`: the membership check, the conditional
 *    revoke (active + same user + same sha256) and the successor session in the same tenant — two
 *    concurrent refreshes of one token cannot both win;
 * 4. if nothing was revoked, find out why, as `{ sub, null }`. A genuine but already-revoked token
 *    means a rotated token came back (stolen copy or replay): every session of the user is revoked.
 *    That revocation runs OUTSIDE the rotation transaction, so throwing afterwards cannot roll it
 *    back.
 */
@CommandHandler(RefreshSessionCommand)
export class RefreshSessionHandler implements ICommandHandler<RefreshSessionCommand> {
  private readonly logger = new Logger(RefreshSessionHandler.name);

  constructor(
    private readonly tokens: TokenIssuer,
    private readonly users: UsersRepository,
    private readonly sessions: SessionsRepository,
    private readonly sessionTokens: SessionTokensService,
    private readonly memberships: MembershipsRepository,
    private readonly transactions: TransactionRunner,
  ) {}

  async execute(command: RefreshSessionCommand): Promise<AuthTokens> {
    const claims = await this.verify(command.refreshToken);
    const refreshTokenHash = sha256Hex(command.refreshToken);
    const now = new Date();
    const owner = userScoped(claims.sub);

    // Fresh email for the new access token; the session row decides the tenant (spec §5.2:
    // refresh keeps it; a router query on Citus) and the membership there the roles.
    const current = await runWithPrincipal(owner, () =>
      this.transactions.run(async () => {
        const user = await this.users.findById(claims.sub);
        if (!user) return null;
        const session = await this.sessions.findById(claims.sub, claims.jti);
        if (
          session === null ||
          !isSessionActive(session, now) ||
          !timingSafeEqualStr(session.refreshTokenHash, refreshTokenHash)
        ) {
          return { user, session: null, membership: null };
        }
        return {
          user,
          session,
          membership: await this.memberships.find(session.tenantId, user.id),
        };
      }),
    );
    if (current === null) throw new InvalidRefreshTokenException();

    const { user, session, membership } = current;
    if (session !== null) {
      const successorId = generateId();
      let membershipGone = membership === null;
      const tokens =
        membership === null
          ? null
          : await this.sessionTokens.openIf(
              {
                user,
                tenantId: session.tenantId,
                roles: membership.roles,
                client: command.client,
                sessionId: successorId,
              },
              async () => {
                if ((await this.memberships.find(session.tenantId, user.id)) === null) {
                  membershipGone = true;
                  return false;
                }
                return this.sessions.revokeForRotation({
                  id: claims.jti,
                  userId: claims.sub,
                  refreshTokenHash,
                  replacedById: successorId,
                  now,
                });
              },
            );
      if (tokens) return tokens;
      if (membershipGone) {
        await runWithPrincipal(owner, () =>
          this.sessions.revoke({ id: session.id, userId: user.id, now }),
        );
        throw new MembershipRevokedException();
      }
    }
    throw await runWithPrincipal(owner, () => this.rejection(claims, refreshTokenHash, now));
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

/** `{ sub, null }`: the refresh token's user, before any tenant is known. */
function userScoped(sub: string): Principal {
  try {
    return createPrincipal({ userId: sub, tenantId: null });
  } catch (error) {
    throw new InvalidRefreshTokenException({ cause: error });
  }
}

import type { AuthTokens } from '@domain/identity-contracts';
import { Logger } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { AccessTokenDenylist, AuthErrorCode, type RefreshTokenClaims } from '@platform/auth';
import {
  type DomainException,
  generateId,
  isPlatformTenantId,
  isUuid,
  sha256Hex,
  UnauthenticatedException,
} from '@platform/common';
import {
  InvalidRefreshTokenException,
  RefreshTokenReuseDetectedException,
  SessionExpiredException,
  TenantAccessDeniedException,
} from '../../../domain/identity.errors.js';
import { classifyRefreshRejection } from '../../../domain/session.js';
import { TokenIssuer } from '../../../infrastructure/security/token-issuer.service.js';
import { MembershipsRepository } from '../../persistence/memberships.repository.js';
import { SessionsRepository } from '../../persistence/sessions.repository.js';
import { UsersRepository } from '../../persistence/users.repository.js';
import { MembershipActivity } from '../../services/membership-activity.elevated.js';
import { SessionTokensService } from '../../services/session-tokens.service.js';
import { requireSelf } from '../../services/tenant-actor.js';
import { SwitchTenantCommand } from './switch-tenant.command.js';

/**
 * Switch tenant = a refresh rotation that lands in another tenant (plan B3 Task 12 flow table):
 * 1. verify the refresh JWT; it must belong to the caller;
 * 2. as the caller: the target membership must exist (else 403, nothing touched);
 * 3. denylist the current access token (it names the old tenant);
 * 4. ONE unit of work as `{ user, target, roles }`: conditionally revoke the presented session,
 *    touch the target membership (`membership-activity`) and open the successor session there. A
 *    failed rotation is classified like refresh, as the caller (reuse → every session revoked).
 */
@CommandHandler(SwitchTenantCommand)
export class SwitchTenantHandler implements ICommandHandler<SwitchTenantCommand> {
  private readonly logger = new Logger(SwitchTenantHandler.name);

  constructor(
    private readonly tokens: TokenIssuer,
    private readonly users: UsersRepository,
    private readonly sessions: SessionsRepository,
    private readonly memberships: MembershipsRepository,
    private readonly sessionTokens: SessionTokensService,
    private readonly activity: MembershipActivity,
    private readonly denylist: AccessTokenDenylist,
  ) {}

  async execute(command: SwitchTenantCommand): Promise<AuthTokens> {
    requireSelf(command.userId);
    const claims = await this.verify(command.refreshToken);
    if (claims.sub !== command.userId) throw new InvalidRefreshTokenException();

    // As the caller: the memberships policy shows the caller's own rows in every tenant.
    const membership =
      isUuid(command.tenantId) && !isPlatformTenantId(command.tenantId)
        ? await this.memberships.find(command.tenantId, command.userId)
        : null;
    if (membership === null) throw new TenantAccessDeniedException();

    const user = await this.users.findById(command.userId);
    if (!user) throw new InvalidRefreshTokenException();

    await this.denylist.deny(command.accessToken.jti, command.accessToken.exp);

    const refreshTokenHash = sha256Hex(command.refreshToken);
    const now = new Date();
    const successorId = generateId();
    const tokens = await this.sessionTokens.openIf(
      {
        user,
        tenantId: membership.tenantId,
        roles: membership.roles,
        client: command.client,
        sessionId: successorId,
      },
      async () => {
        const rotated = await this.sessions.revokeForRotation({
          id: claims.jti,
          userId: claims.sub,
          refreshTokenHash,
          replacedById: successorId,
          now,
        });
        if (!rotated) return false;
        await this.activity.touch(membership.tenantId, user.id, now);
        return true;
      },
    );
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
    const session = await this.sessions.findById(claims.sub, claims.jti);
    switch (classifyRefreshRejection(session, { userId: claims.sub, refreshTokenHash, now })) {
      case 'reused': {
        const revoked = await this.sessions.revokeAllForUser(claims.sub, now);
        this.logger.warn(
          { userId: claims.sub, sessionId: claims.jti, revokedSessions: revoked },
          'Refresh token reuse detected on switch-tenant: all sessions of the user revoked',
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

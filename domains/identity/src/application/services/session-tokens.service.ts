import type { AuthTokens, ClientInfo } from '@domain/identity-contracts';
import { Injectable } from '@nestjs/common';
import { generateId, sha256Hex, type TenantRole } from '@platform/common';
import { BEARER_TOKEN_TYPE } from '../../identity.constants.js';
import { TokenIssuer } from '../../infrastructure/security/token-issuer.service.js';
import { toSessionClient } from '../mappers/client-info.mapper.js';
import { toAccessTokenSubject, toUserContract } from '../mappers/user.mapper.js';
import { SessionsRepository } from '../persistence/sessions.repository.js';
import type { UserRecord } from '../persistence/users.repository.js';

/** Everything a new session needs: the user, its tenant and its roles there. */
export interface OpenSessionInput {
  readonly user: UserRecord;
  readonly tenantId: string;
  readonly roles: readonly TenantRole[];
  readonly client?: ClientInfo | null | undefined;
  /** The refresh token's `jti`; a fresh uuidv7 by default (rotation passes the successor id). */
  readonly sessionId?: string | undefined;
}

/**
 * Opens a session in one tenant and issues its token pair — shared by register, login, refresh and
 * switch: refresh JWT (own secret) with `jti` = session id, only `sha256(token)` stored; access JWT
 * (verified locally at the edge). Runs inside the caller's transaction when there is one.
 */
@Injectable()
export class SessionTokensService {
  constructor(
    private readonly tokens: TokenIssuer,
    private readonly sessions: SessionsRepository,
  ) {}

  async open(input: OpenSessionInput): Promise<AuthTokens> {
    const sessionId = input.sessionId ?? generateId();
    // Signing is CPU-only (HS256): both tokens in parallel, then a single INSERT.
    const [refresh, access] = await Promise.all([
      this.tokens.issueRefreshToken({ userId: input.user.id, sessionId }),
      this.tokens.issueAccessToken(toAccessTokenSubject(input.user, input.tenantId, input.roles)),
    ]);
    await this.sessions.create({
      id: sessionId,
      userId: input.user.id,
      tenantId: input.tenantId,
      refreshTokenHash: sha256Hex(refresh.token),
      expiresAt: refresh.expiresAt,
      ...toSessionClient(input.client),
    });
    return {
      accessToken: access.token,
      refreshToken: refresh.token,
      expiresIn: access.expiresIn,
      tokenType: BEARER_TOKEN_TYPE,
      user: toUserContract(input.user),
      tenantId: input.tenantId,
      tenantRoles: [...input.roles],
    };
  }
}

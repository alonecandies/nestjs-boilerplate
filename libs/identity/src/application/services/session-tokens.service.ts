import { TokenService } from '@app/auth';
import { generateId, sha256Hex } from '@app/common';
import type { AuthTokens, ClientInfo } from '@app/contracts';
import { Injectable } from '@nestjs/common';
import { BEARER_TOKEN_TYPE } from '../../identity.constants.js';
import { toSessionClient } from '../mappers/client-info.mapper.js';
import { toAccessTokenSubject, toUserContract } from '../mappers/user.mapper.js';
import { SessionsRepository } from '../persistence/sessions.repository.js';
import type { UserRecord } from '../persistence/users.repository.js';

/**
 * Opens a session and issues its token pair — shared by register, login and refresh rotation:
 * - refresh JWT (7 d, own secret) with `jti` = session id; only `sha256(token)` is stored,
 * - access JWT (15 min) carrying id, email and roles (verified locally at the edge).
 * Runs inside the caller's transaction when there is one (the session insert joins it).
 */
@Injectable()
export class SessionTokensService {
  constructor(
    private readonly tokens: TokenService,
    private readonly sessions: SessionsRepository,
  ) {}

  async open(
    user: UserRecord,
    client: ClientInfo | null | undefined,
    sessionId: string = generateId(),
  ): Promise<AuthTokens> {
    // Signing is CPU-only (HS256): both tokens in parallel, then a single INSERT.
    const [refresh, access] = await Promise.all([
      this.tokens.issueRefreshToken({ userId: user.id, sessionId }),
      this.tokens.issueAccessToken(toAccessTokenSubject(user)),
    ]);
    await this.sessions.create({
      id: sessionId,
      userId: user.id,
      refreshTokenHash: sha256Hex(refresh.token),
      expiresAt: refresh.expiresAt,
      ...toSessionClient(client),
    });
    return {
      accessToken: access.token,
      refreshToken: refresh.token,
      expiresIn: access.expiresIn,
      tokenType: BEARER_TOKEN_TYPE,
      user: toUserContract(user),
    };
  }
}

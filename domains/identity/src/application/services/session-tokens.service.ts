import type { AuthTokens, ClientInfo } from '@domain/identity-contracts';
import { Injectable } from '@nestjs/common';
import {
  createPrincipal,
  generateId,
  getPrincipal,
  type Principal,
  runWithPrincipal,
  sha256Hex,
  TenancyErrorCode,
  type TenantRole,
  UnauthenticatedException,
} from '@platform/common';
import { BEARER_TOKEN_TYPE } from '../../identity.constants.js';
import { TokenIssuer } from '../../infrastructure/security/token-issuer.service.js';
import { toSessionClient } from '../mappers/client-info.mapper.js';
import { toAccessTokenSubject, toUserContract } from '../mappers/user.mapper.js';
import { SessionsRepository } from '../persistence/sessions.repository.js';
import { TransactionRunner } from '../persistence/transaction-runner.js';
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

/** The principal of a session's unit of work: the session's user in the session's tenant. */
export function sessionPrincipal(input: Pick<OpenSessionInput, 'user' | 'tenantId' | 'roles'>) {
  return createPrincipal({ userId: input.user.id, tenantId: input.tenantId, roles: input.roles });
}

/**
 * Opens a session in one tenant and issues its token pair — shared by register, login, refresh and
 * switch: refresh JWT (own secret) with `jti` = session id, only `sha256(token)` stored; access JWT
 * (verified locally at the edge).
 *
 * B3 (one principal per transaction): the unit of work that inserts the session runs as
 * `{ user, tenant, roles }`, set with `runWithPrincipal` BEFORE it opens. `before` runs first in that
 * same unit of work (the flow's own writes: register's user and workspace, login's `touch`, a
 * rotation's revoke). Called inside a caller's transaction, the unit of work joins it, which the
 * adapter allows only when the caller already runs as that user in that tenant (`RLS_CONTEXT_STALE`
 * otherwise): the principal never changes inside an open transaction. Both tokens are signed (CPU
 * only) before BEGIN.
 */
@Injectable()
export class SessionTokensService {
  constructor(
    private readonly tokens: TokenIssuer,
    private readonly sessions: SessionsRepository,
    private readonly transaction: TransactionRunner,
  ) {}

  /** `before`, then the session insert, in one unit of work as the session's principal. */
  async open(input: OpenSessionInput, before?: () => Promise<void>): Promise<AuthTokens> {
    const tokens = await this.openIf(input, async () => {
      await before?.();
      return true;
    });
    if (tokens === null) throw new Error('SessionTokensService.open: no session was opened');
    return tokens;
  }

  /**
   * As `open`, but `before` decides: `false` ends the unit of work without a session (it still
   * commits what `before` wrote, e.g. nothing after a lost rotation) and returns null.
   */
  async openIf(
    input: OpenSessionInput,
    before: () => Promise<boolean>,
  ): Promise<AuthTokens | null> {
    const principal = sessionPrincipal(input);
    assertSameUser(principal);
    const sessionId = input.sessionId ?? generateId();
    // Signing is CPU-only (HS256): both tokens in parallel, before the transaction opens.
    const [refresh, access] = await Promise.all([
      this.tokens.issueRefreshToken({ userId: input.user.id, sessionId }),
      this.tokens.issueAccessToken(toAccessTokenSubject(input.user, input.tenantId, input.roles)),
    ]);
    const opened = await runWithPrincipal(principal, () =>
      this.transaction.run(async () => {
        if (!(await before())) return false;
        await this.sessions.create({
          id: sessionId,
          userId: input.user.id,
          tenantId: input.tenantId,
          refreshTokenHash: sha256Hex(refresh.token),
          expiresAt: refresh.expiresAt,
          ...toSessionClient(input.client),
        });
        return true;
      }),
    );
    if (!opened) return null;
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

/** I-2: another user's principal is never replaced (fail closed). */
function assertSameUser(next: Principal): void {
  const current = getPrincipal();
  if (current !== undefined && current.userId !== next.userId) {
    throw new UnauthenticatedException('Principal mismatch', {
      code: TenancyErrorCode.INVALID_PRINCIPAL,
      details: { reason: 'principal mismatch' },
    });
  }
}

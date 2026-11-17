import { AuthErrorCode, type RefreshTokenClaims } from '@platform/auth';
import {
  generateId,
  isUuidV7,
  runWithPrincipal,
  sha256Hex,
  UnauthenticatedException,
} from '@platform/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeAuthTokens, makeUserRecord } from '../../../../test/fixtures.js';
import { mockOf } from '../../../../test/mocks.js';
import { principalLog } from '../../../../test/principal-log.js';
import {
  InvalidRefreshTokenException,
  MembershipRevokedException,
  RefreshTokenReuseDetectedException,
  SessionExpiredException,
} from '../../../domain/identity.errors.js';
import type { TokenIssuer } from '../../../infrastructure/security/token-issuer.service.js';
import type { MembershipsRepository } from '../../persistence/memberships.repository.js';
import type { SessionRecord, SessionsRepository } from '../../persistence/sessions.repository.js';
import type { UsersRepository } from '../../persistence/users.repository.js';
import {
  type OpenSessionInput,
  type SessionTokensService,
  sessionPrincipal,
} from '../../services/session-tokens.service.js';
import { RefreshSessionCommand } from './refresh-session.command.js';
import { RefreshSessionHandler } from './refresh-session.handler.js';

const REFRESH_TOKEN = 'header.payload.signature';
const TENANT = '0190f3b2-0000-7000-8000-0000000000aa';

describe('RefreshSessionHandler', () => {
  const user = makeUserRecord();
  const sessionId = generateId();
  const claims: RefreshTokenClaims = {
    sub: user.id,
    jti: sessionId,
    typ: 'refresh',
    iat: 1,
    exp: 2,
    iss: 'iss',
    aud: 'aud',
  };
  const storedSession = (overrides: Partial<SessionRecord> = {}): SessionRecord => ({
    id: sessionId,
    userId: user.id,
    tenantId: TENANT,
    refreshTokenHash: sha256Hex(REFRESH_TOKEN),
    userAgent: null,
    ip: null,
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null,
    replacedById: null,
    createdAt: new Date(),
    ...overrides,
  });
  const tokens = makeAuthTokens();
  const log: string[] = [];

  let tokenIssuer: ReturnType<typeof mockOf<TokenIssuer>>;
  let users: ReturnType<typeof mockOf<UsersRepository>>;
  let sessions: ReturnType<typeof mockOf<SessionsRepository>>;
  let memberships: ReturnType<typeof mockOf<MembershipsRepository>>;
  let sessionTokens: ReturnType<typeof mockOf<SessionTokensService>>;
  let principals: ReturnType<typeof principalLog>;
  let handler: RefreshSessionHandler;

  beforeEach(() => {
    log.length = 0;
    tokenIssuer = mockOf<TokenIssuer>({ verifyRefreshToken: async () => claims });
    users = mockOf<UsersRepository>({ findById: async () => user });
    sessions = mockOf<SessionsRepository>({
      findById: async () => storedSession(),
      revokeForRotation: async () => {
        log.push('revoke-for-rotation');
        return true;
      },
      revoke: async () => {
        log.push('revoke');
        return true;
      },
      revokeAllForUser: async () => {
        log.push('revoke-all');
        return 3;
      },
    });
    memberships = mockOf<MembershipsRepository>({
      find: async () => ({
        tenantId: TENANT,
        userId: user.id,
        roles: ['admin'],
        lastActiveAt: null,
        createdAt: new Date(),
      }),
    });
    // The real service: ONE unit of work as the session's principal, `before` first (its spec).
    sessionTokens = mockOf<SessionTokensService>({
      openIf: (input: OpenSessionInput, before: () => Promise<boolean>) =>
        runWithPrincipal(sessionPrincipal(input), async () => {
          log.push('begin');
          const opened = await before();
          if (opened) log.push('open-successor');
          log.push('commit');
          return opened ? tokens : null;
        }),
    });
    principals = principalLog();
    handler = new RefreshSessionHandler(
      tokenIssuer,
      principals.track('users', users),
      principals.track('sessions', sessions),
      principals.track('sessionTokens', sessionTokens),
      principals.track('memberships', memberships),
    );
  });

  const command = new RefreshSessionCommand(REFRESH_TOKEN, { ip: '1.2.3.4' });

  it("rotates atomically inside the session's tenant, with the membership's current roles", async () => {
    await expect(handler.execute(command)).resolves.toBe(tokens);
    expect(sessions.findById).toHaveBeenCalledWith(user.id, sessionId);
    expect(memberships.find).toHaveBeenCalledWith(TENANT, user.id);
    expect(log).toEqual(['begin', 'revoke-for-rotation', 'open-successor', 'commit']);
    const [input] = sessionTokens.openIf.mock.calls[0] ?? [];
    expect(input).toMatchObject({
      user,
      tenantId: TENANT,
      roles: ['admin'],
      client: { ip: '1.2.3.4' },
    });
    expect(isUuidV7(input?.sessionId)).toBe(true);
    expect(sessions.revokeForRotation).toHaveBeenCalledWith({
      id: sessionId,
      userId: user.id,
      refreshTokenHash: sha256Hex(REFRESH_TOKEN),
      replacedById: input?.sessionId,
      now: expect.any(Date),
    });
  });

  it('reads as { sub, null }, rotates as { sub, session.tenantId, roles } (flow table)', async () => {
    await handler.execute(command);
    expect(principals.summary()).toEqual([
      ['users.findById', user.id, null],
      ['sessions.findById', user.id, null],
      ['memberships.find', user.id, null],
      ['sessionTokens.openIf', null, null],
      ['memberships.find', user.id, TENANT],
      ['sessions.revokeForRotation', user.id, TENANT],
    ]);
    expect(principals.calls.at(-1)?.principal?.roles).toEqual(['admin']);
  });

  it('membership removed since login → session revoked as { sub, null }, 401 MEMBERSHIP_REVOKED, nothing issued', async () => {
    memberships.find.mockResolvedValue(null);
    await expect(handler.execute(command)).rejects.toBeInstanceOf(MembershipRevokedException);
    expect(sessions.revoke).toHaveBeenCalledWith({
      id: sessionId,
      userId: user.id,
      now: expect.any(Date),
    });
    expect(log).toEqual(['revoke']);
    expect(principals.summary().at(-1)).toEqual(['sessions.revoke', user.id, null]);
  });

  it('membership removed between the read and the rotation → nothing rotated, session revoked after', async () => {
    memberships.find
      .mockResolvedValueOnce({
        tenantId: TENANT,
        userId: user.id,
        roles: ['admin'],
        lastActiveAt: null,
        createdAt: new Date(),
      })
      .mockResolvedValueOnce(null);
    await expect(handler.execute(command)).rejects.toBeInstanceOf(MembershipRevokedException);
    expect(sessions.revokeForRotation).not.toHaveBeenCalled();
    expect(log).toEqual(['begin', 'commit', 'revoke']);
  });

  it('REUSE: a genuine but already-rotated token revokes every session, outside any transaction', async () => {
    sessions.findById.mockResolvedValue(storedSession({ revokedAt: new Date() }));
    await expect(handler.execute(command)).rejects.toBeInstanceOf(
      RefreshTokenReuseDetectedException,
    );
    expect(sessions.revokeAllForUser).toHaveBeenCalledWith(user.id, expect.any(Date));
    expect(log).toEqual(['revoke-all']);
    expect(memberships.find).not.toHaveBeenCalled();
    expect(principals.summary().at(-1)).toEqual(['sessions.revokeAllForUser', user.id, null]);
  });

  it('a concurrent rotation that wins between the read and the update is classified as reuse', async () => {
    sessions.findById
      .mockResolvedValueOnce(storedSession())
      .mockResolvedValueOnce(storedSession({ revokedAt: new Date() }));
    sessions.revokeForRotation.mockResolvedValue(false);
    await expect(handler.execute(command)).rejects.toBeInstanceOf(
      RefreshTokenReuseDetectedException,
    );
    expect(sessions.revokeForRotation).toHaveBeenCalledOnce();
    // The lost rotation commits nothing; the revocation runs after, outside the transaction.
    expect(log).toEqual(['begin', 'commit', 'revoke-all']);
  });

  it('expired session → SessionExpiredException; unknown session or hash mismatch → InvalidRefreshTokenException', async () => {
    sessions.findById.mockResolvedValue(storedSession({ expiresAt: new Date(Date.now() - 1) }));
    await expect(handler.execute(command)).rejects.toBeInstanceOf(SessionExpiredException);
    sessions.findById.mockResolvedValue(null);
    await expect(handler.execute(command)).rejects.toBeInstanceOf(InvalidRefreshTokenException);
    sessions.findById.mockResolvedValue(storedSession({ refreshTokenHash: sha256Hex('other') }));
    await expect(handler.execute(command)).rejects.toBeInstanceOf(InvalidRefreshTokenException);
    expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
  });

  it('maps JWT failures before touching the database', async () => {
    tokenIssuer.verifyRefreshToken.mockRejectedValue(
      new UnauthenticatedException('expired', { code: AuthErrorCode.TOKEN_EXPIRED }),
    );
    await expect(handler.execute(command)).rejects.toBeInstanceOf(SessionExpiredException);
    tokenIssuer.verifyRefreshToken.mockRejectedValue(new Error('bad signature'));
    await expect(handler.execute(command)).rejects.toBeInstanceOf(InvalidRefreshTokenException);
    expect(users.findById).not.toHaveBeenCalled();
  });

  it('a deleted user → InvalidRefreshTokenException', async () => {
    users.findById.mockResolvedValue(null);
    await expect(handler.execute(command)).rejects.toBeInstanceOf(InvalidRefreshTokenException);
    vi.clearAllMocks();
  });
});

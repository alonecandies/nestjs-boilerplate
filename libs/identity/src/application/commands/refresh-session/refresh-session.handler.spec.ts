import { AuthErrorCode, type RefreshTokenClaims, type TokenService } from '@app/auth';
import { generateId, sha256Hex, UnauthenticatedException } from '@app/common';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  makeAuthTokens,
  makeUserRecord,
  passThroughTransaction,
} from '../../../../test/fixtures.js';
import { mockOf } from '../../../../test/mocks.js';
import {
  InvalidRefreshTokenException,
  RefreshTokenReuseDetectedException,
  SessionExpiredException,
} from '../../../domain/identity.errors.js';
import type { SessionRecord, SessionsRepository } from '../../persistence/sessions.repository.js';
import type { UsersRepository } from '../../persistence/users.repository.js';
import type { SessionTokensService } from '../../services/session-tokens.service.js';
import { RefreshSessionCommand } from './refresh-session.command.js';
import { RefreshSessionHandler } from './refresh-session.handler.js';

const REFRESH_TOKEN = 'header.payload.signature';

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

  let tokenService: ReturnType<typeof mockOf<TokenService>>;
  let users: ReturnType<typeof mockOf<UsersRepository>>;
  let sessions: ReturnType<typeof mockOf<SessionsRepository>>;
  let sessionTokens: ReturnType<typeof mockOf<SessionTokensService>>;
  let transaction: ReturnType<typeof passThroughTransaction>;
  let handler: RefreshSessionHandler;
  const log: string[] = [];

  beforeEach(() => {
    log.length = 0;
    tokenService = mockOf<TokenService>({ verifyRefreshToken: async () => claims });
    users = mockOf<UsersRepository>({ findById: async () => user });
    sessions = mockOf<SessionsRepository>({
      revokeForRotation: async () => {
        log.push('revoke-for-rotation');
        return true;
      },
      findById: async () => storedSession({ revokedAt: new Date() }),
      revokeAllForUser: async () => {
        log.push('revoke-all');
        return 3;
      },
    });
    sessionTokens = mockOf<SessionTokensService>({
      open: async () => {
        log.push('open-successor');
        return tokens;
      },
    });
    transaction = {
      ...passThroughTransaction(),
      run: async <T>(work: () => Promise<T>): Promise<T> => {
        log.push('begin');
        const result = await work();
        log.push('commit');
        return result;
      },
      runs: 0,
    };
    handler = new RefreshSessionHandler(tokenService, users, sessions, sessionTokens, transaction);
  });

  const command = new RefreshSessionCommand(REFRESH_TOKEN, { ip: '1.2.3.4' });

  it('rotates atomically: revoke the presented session + open its successor in one transaction', async () => {
    await expect(handler.execute(command)).resolves.toBe(tokens);

    expect(tokenService.verifyRefreshToken).toHaveBeenCalledWith(REFRESH_TOKEN);
    const [rotation] = sessions.revokeForRotation.mock.calls[0] ?? [];
    expect(rotation).toMatchObject({
      id: sessionId,
      userId: user.id,
      refreshTokenHash: sha256Hex(REFRESH_TOKEN),
    });
    const [openedFor, client, successorId] = sessionTokens.open.mock.calls[0] ?? [];
    expect(openedFor).toBe(user);
    expect(client).toEqual({ ip: '1.2.3.4' });
    expect(successorId).toBe(rotation?.replacedById);
    expect(log).toEqual(['begin', 'revoke-for-rotation', 'open-successor', 'commit']);
  });

  it('REUSE: a genuine but already-rotated token revokes every session — after the transaction', async () => {
    sessions.revokeForRotation.mockImplementation(async () => {
      log.push('revoke-for-rotation');
      return false;
    });

    await expect(handler.execute(command)).rejects.toBeInstanceOf(
      RefreshTokenReuseDetectedException,
    );

    expect(sessions.revokeAllForUser).toHaveBeenCalledWith(user.id, expect.any(Date));
    // Outside the rotation transaction: the throw that follows cannot roll it back.
    expect(log).toEqual(['begin', 'revoke-for-rotation', 'commit', 'revoke-all']);
    expect(sessionTokens.open).not.toHaveBeenCalled();
  });

  it('expired session → SessionExpiredException (no family revocation)', async () => {
    sessions.revokeForRotation.mockResolvedValue(false);
    sessions.findById.mockResolvedValue(storedSession({ expiresAt: new Date(Date.now() - 1) }));
    await expect(handler.execute(command)).rejects.toBeInstanceOf(SessionExpiredException);
    expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
  });

  it('unknown session or hash mismatch → InvalidRefreshTokenException (no family revocation)', async () => {
    sessions.revokeForRotation.mockResolvedValue(false);
    sessions.findById.mockResolvedValue(null);
    await expect(handler.execute(command)).rejects.toBeInstanceOf(InvalidRefreshTokenException);

    sessions.findById.mockResolvedValue(
      storedSession({ refreshTokenHash: sha256Hex('another'), revokedAt: new Date() }),
    );
    await expect(handler.execute(command)).rejects.toBeInstanceOf(InvalidRefreshTokenException);
    expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
  });

  it('maps JWT failures before touching the database: expired → SESSION_EXPIRED, other → INVALID_REFRESH_TOKEN', async () => {
    tokenService.verifyRefreshToken.mockRejectedValue(
      new UnauthenticatedException('Token has expired', { code: AuthErrorCode.TOKEN_EXPIRED }),
    );
    await expect(handler.execute(command)).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });

    tokenService.verifyRefreshToken.mockRejectedValue(
      new UnauthenticatedException('Invalid token', { code: AuthErrorCode.INVALID_TOKEN }),
    );
    await expect(handler.execute(command)).rejects.toMatchObject({
      code: 'INVALID_REFRESH_TOKEN',
      httpStatus: 401,
    });
    expect(users.findById).not.toHaveBeenCalled();
    expect(sessions.revokeForRotation).not.toHaveBeenCalled();
  });

  it('a deleted user → InvalidRefreshTokenException', async () => {
    users.findById.mockResolvedValue(null);
    await expect(handler.execute(command)).rejects.toBeInstanceOf(InvalidRefreshTokenException);
    expect(sessions.revokeForRotation).not.toHaveBeenCalled();
  });
});

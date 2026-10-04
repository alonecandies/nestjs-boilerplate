import type { TokenService } from '@app/auth';
import { sha256Hex } from '@app/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { makeUserRecord } from '../../../test/fixtures.js';
import { mockOf } from '../../../test/mocks.js';
import type { SessionsRepository } from '../persistence/sessions.repository.js';
import { SessionTokensService } from './session-tokens.service.js';

describe('SessionTokensService', () => {
  const expiresAt = new Date('2026-10-06T12:00:00.000Z');
  let tokens: ReturnType<typeof mockOf<TokenService>>;
  let sessions: ReturnType<typeof mockOf<SessionsRepository>>;
  let service: SessionTokensService;

  beforeEach(() => {
    tokens = mockOf<TokenService>({
      issueRefreshToken: async () => ({ token: 'refresh-jwt', expiresAt }),
      issueAccessToken: async () => ({ token: 'access-jwt', jti: 'jti', expiresIn: 900, exp: 1 }),
    });
    sessions = mockOf<SessionsRepository>({ create: async () => undefined });
    service = new SessionTokensService(tokens, sessions);
  });

  it('opens a session storing only sha256(refresh token) and returns the contract token pair', async () => {
    const user = makeUserRecord({ roles: ['admin', 'user'] });

    const result = await service.open(user, { userAgent: ' curl/8 ', ip: '10.0.0.1' }, 'sid-1');

    expect(tokens.issueRefreshToken).toHaveBeenCalledWith({ userId: user.id, sessionId: 'sid-1' });
    expect(tokens.issueAccessToken).toHaveBeenCalledWith({
      id: user.id,
      email: user.email,
      roles: ['admin', 'user'],
    });
    expect(sessions.create).toHaveBeenCalledWith({
      id: 'sid-1',
      userId: user.id,
      refreshTokenHash: sha256Hex('refresh-jwt'),
      expiresAt,
      userAgent: 'curl/8',
      ip: '10.0.0.1',
    });
    expect(result).toEqual({
      accessToken: 'access-jwt',
      refreshToken: 'refresh-jwt',
      expiresIn: 900,
      tokenType: 'Bearer',
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        roles: ['admin', 'user'],
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      },
    });
  });

  it('generates a uuidv7 session id and stores null client info when none is known', async () => {
    await service.open(makeUserRecord(), undefined);
    const [session] = sessions.create.mock.calls[0] ?? [];
    expect(session?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    expect(session).toMatchObject({ userAgent: null, ip: null });
  });
});

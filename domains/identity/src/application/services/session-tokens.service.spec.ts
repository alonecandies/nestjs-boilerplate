import { sha256Hex } from '@platform/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { makeUserRecord } from '../../../test/fixtures.js';
import { mockOf } from '../../../test/mocks.js';
import type { TokenIssuer } from '../../infrastructure/security/token-issuer.service.js';
import type { SessionsRepository } from '../persistence/sessions.repository.js';
import { SessionTokensService } from './session-tokens.service.js';

const TENANT = '0190f3b2-0000-7000-8000-0000000000aa';

describe('SessionTokensService', () => {
  const expiresAt = new Date('2026-10-06T12:00:00.000Z');
  let tokens: ReturnType<typeof mockOf<TokenIssuer>>;
  let sessions: ReturnType<typeof mockOf<SessionsRepository>>;
  let service: SessionTokensService;

  beforeEach(() => {
    tokens = mockOf<TokenIssuer>({
      issueRefreshToken: async () => ({ token: 'refresh-jwt', expiresAt }),
      issueAccessToken: async () => ({ token: 'access-jwt', jti: 'jti', expiresIn: 900, exp: 1 }),
    });
    sessions = mockOf<SessionsRepository>({ create: async () => undefined });
    service = new SessionTokensService(tokens, sessions);
  });

  it('opens a tenant-bound session (sha256 of the refresh token only) and returns the tenant with the pair', async () => {
    const user = makeUserRecord({ roles: ['admin', 'user'] });

    const result = await service.open({
      user,
      tenantId: TENANT,
      roles: ['owner'],
      client: { userAgent: ' curl/8 ', ip: '10.0.0.1' },
      sessionId: 'sid-1',
    });

    expect(tokens.issueRefreshToken).toHaveBeenCalledWith({ userId: user.id, sessionId: 'sid-1' });
    expect(tokens.issueAccessToken).toHaveBeenCalledWith({
      id: user.id,
      email: user.email,
      tenantId: TENANT,
      roles: ['owner'],
    });
    expect(sessions.create).toHaveBeenCalledWith({
      id: 'sid-1',
      userId: user.id,
      tenantId: TENANT,
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
      tenantId: TENANT,
      tenantRoles: ['owner'],
    });
  });

  it('generates a uuidv7 session id and stores null client info when none is known', async () => {
    await service.open({ user: makeUserRecord(), tenantId: TENANT, roles: ['member'] });
    const [session] = sessions.create.mock.calls[0] ?? [];
    expect(session?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    expect(session).toMatchObject({ tenantId: TENANT, userAgent: null, ip: null });
  });
});

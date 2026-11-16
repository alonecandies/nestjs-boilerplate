import type { AccessTokenDenylist, RefreshTokenClaims } from '@platform/auth';
import { generateId, PLATFORM_TENANT_ID, sha256Hex } from '@platform/common';
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
  TenantAccessDeniedException,
} from '../../../domain/identity.errors.js';
import type { TokenIssuer } from '../../../infrastructure/security/token-issuer.service.js';
import type { MembershipsRepository } from '../../persistence/memberships.repository.js';
import type { SessionRecord, SessionsRepository } from '../../persistence/sessions.repository.js';
import type { UsersRepository } from '../../persistence/users.repository.js';
import type { SessionTokensService } from '../../services/session-tokens.service.js';
import { SwitchTenantCommand } from './switch-tenant.command.js';
import { SwitchTenantHandler } from './switch-tenant.handler.js';

const REFRESH = 'header.payload.signature';
const FROM = '0190f3b2-0000-7000-8000-0000000000a1';
const TO = '0190f3b2-0000-7000-8000-0000000000a2';

describe('SwitchTenantHandler', () => {
  const user = makeUserRecord();
  const sessionId = generateId();
  const claims: RefreshTokenClaims = {
    sub: user.id,
    jti: sessionId,
    typ: 'refresh',
    iat: 1,
    exp: 2,
    iss: 'i',
    aud: 'a',
  };
  const access = { jti: 'access-jti', exp: 1_900_000_000 };
  const tokens = makeAuthTokens({ tenantId: TO, tenantRoles: ['member'] });
  const log: string[] = [];
  const session = (overrides: Partial<SessionRecord> = {}): SessionRecord => ({
    id: sessionId,
    userId: user.id,
    tenantId: FROM,
    refreshTokenHash: sha256Hex(REFRESH),
    userAgent: null,
    ip: null,
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null,
    replacedById: null,
    createdAt: new Date(),
    ...overrides,
  });

  let issuer: ReturnType<typeof mockOf<TokenIssuer>>;
  let users: ReturnType<typeof mockOf<UsersRepository>>;
  let sessions: ReturnType<typeof mockOf<SessionsRepository>>;
  let memberships: ReturnType<typeof mockOf<MembershipsRepository>>;
  let sessionTokens: ReturnType<typeof mockOf<SessionTokensService>>;
  let denylist: ReturnType<typeof mockOf<AccessTokenDenylist>>;
  let handler: SwitchTenantHandler;

  beforeEach(() => {
    log.length = 0;
    issuer = mockOf<TokenIssuer>({ verifyRefreshToken: async () => claims });
    users = mockOf<UsersRepository>({ findById: async () => user });
    sessions = mockOf<SessionsRepository>({
      findById: async () => session(),
      revokeForRotation: async () => {
        log.push('rotate');
        return true;
      },
      revokeAllForUser: async () => {
        log.push('revoke-all');
        return 2;
      },
    });
    memberships = mockOf<MembershipsRepository>({
      find: async (tenantId: string) =>
        tenantId === TO
          ? {
              tenantId: TO,
              userId: user.id,
              roles: ['member'],
              lastActiveAt: null,
              createdAt: new Date(),
            }
          : null,
      touch: async () => {
        log.push('touch');
      },
    });
    sessionTokens = mockOf<SessionTokensService>({
      open: async () => {
        log.push('open');
        return tokens;
      },
    });
    denylist = mockOf<AccessTokenDenylist>({
      deny: async () => {
        log.push('deny');
      },
    });
    const transaction = {
      ...passThroughTransaction(),
      run: async <T>(work: () => Promise<T>): Promise<T> => {
        log.push('begin');
        const result = await work();
        log.push('commit');
        return result;
      },
    };
    handler = new SwitchTenantHandler(
      issuer,
      users,
      sessions,
      memberships,
      sessionTokens,
      transaction,
      denylist,
    );
  });

  const command = (tenantId = TO) =>
    new SwitchTenantCommand(user.id, tenantId, REFRESH, access, { ip: '10.0.0.1' });

  it('rotates the session into the target tenant with its roles and denylists the old access token', async () => {
    await expect(handler.execute(command())).resolves.toBe(tokens);
    expect(log).toEqual(['deny', 'begin', 'rotate', 'touch', 'open', 'commit']);
    expect(denylist.deny).toHaveBeenCalledWith('access-jti', 1_900_000_000);
    const [input] = sessionTokens.open.mock.calls[0] ?? [];
    expect(input).toMatchObject({
      user,
      tenantId: TO,
      roles: ['member'],
      client: { ip: '10.0.0.1' },
    });
    expect(sessions.revokeForRotation).toHaveBeenCalledWith({
      id: sessionId,
      userId: user.id,
      refreshTokenHash: sha256Hex(REFRESH),
      replacedById: input?.sessionId,
      now: expect.any(Date),
    });
    expect(memberships.touch).toHaveBeenCalledWith(TO, user.id, expect.any(Date));
  });

  it.each([
    ['a tenant the user is not a member of', '0190f3b2-0000-7000-8000-0000000000bb'],
    ['the platform tenant', PLATFORM_TENANT_ID],
    ['a malformed id', 'nope'],
  ])(
    '%s → 403 TENANT_ACCESS_DENIED; nothing rotated or denylisted (Review Focus 1)',
    async (_name, tenantId) => {
      await expect(handler.execute(command(tenantId))).rejects.toBeInstanceOf(
        TenantAccessDeniedException,
      );
      expect(log).toEqual([]);
    },
  );

  it("someone else's refresh token → 401 INVALID_REFRESH_TOKEN before any lookup", async () => {
    issuer.verifyRefreshToken.mockResolvedValue({
      ...claims,
      sub: '0190f3b2-0000-7000-8000-0000000000ff',
    });
    await expect(handler.execute(command())).rejects.toBeInstanceOf(InvalidRefreshTokenException);
    expect(memberships.find).not.toHaveBeenCalled();
  });

  it('a reused (already rotated) refresh token revokes every session: 401 REFRESH_TOKEN_REUSED', async () => {
    sessions.revokeForRotation.mockResolvedValue(false);
    sessions.findById.mockResolvedValue(session({ revokedAt: new Date() }));
    await expect(handler.execute(command())).rejects.toBeInstanceOf(
      RefreshTokenReuseDetectedException,
    );
    expect(sessions.findById).toHaveBeenCalledWith(user.id, sessionId);
    expect(log).toContain('revoke-all');
    expect(sessionTokens.open).not.toHaveBeenCalled();
  });
});

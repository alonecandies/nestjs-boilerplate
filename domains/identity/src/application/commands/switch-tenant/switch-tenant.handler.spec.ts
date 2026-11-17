import type { AccessTokenDenylist, RefreshTokenClaims } from '@platform/auth';
import {
  createPrincipal,
  generateId,
  PLATFORM_TENANT_ID,
  runWithPrincipal,
  sha256Hex,
  UnauthenticatedException,
} from '@platform/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { makeAuthTokens, makeUserRecord } from '../../../../test/fixtures.js';
import { mockOf } from '../../../../test/mocks.js';
import { principalLog } from '../../../../test/principal-log.js';
import {
  InvalidRefreshTokenException,
  RefreshTokenReuseDetectedException,
  TenantAccessDeniedException,
} from '../../../domain/identity.errors.js';
import type { TokenIssuer } from '../../../infrastructure/security/token-issuer.service.js';
import type { MembershipsRepository } from '../../persistence/memberships.repository.js';
import type { SessionRecord, SessionsRepository } from '../../persistence/sessions.repository.js';
import type { UsersRepository } from '../../persistence/users.repository.js';
import type { MembershipActivity } from '../../services/membership-activity.elevated.js';
import {
  type OpenSessionInput,
  type SessionTokensService,
  sessionPrincipal,
} from '../../services/session-tokens.service.js';
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
  let activity: ReturnType<typeof mockOf<MembershipActivity>>;
  let principals: ReturnType<typeof principalLog>;
  let handler: SwitchTenantHandler;
  /** The caller: the access token's user in its current tenant (the edge sets it). */
  const caller = () => createPrincipal({ userId: user.id, tenantId: FROM, roles: ['admin'] });
  const run = (cmd: SwitchTenantCommand) => runWithPrincipal(caller(), () => handler.execute(cmd));

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
    });
    activity = mockOf<MembershipActivity>({
      touch: async () => {
        log.push('touch');
      },
    });
    // The real service: ONE unit of work as the session's principal, `before` first (its spec).
    sessionTokens = mockOf<SessionTokensService>({
      openIf: (input: OpenSessionInput, before: () => Promise<boolean>) =>
        runWithPrincipal(sessionPrincipal(input), async () => {
          log.push('begin');
          const opened = await before();
          if (opened) log.push('open');
          log.push('commit');
          return opened ? tokens : null;
        }),
    });
    denylist = mockOf<AccessTokenDenylist>({
      deny: async () => {
        log.push('deny');
      },
    });
    principals = principalLog();
    handler = new SwitchTenantHandler(
      issuer,
      principals.track('users', users),
      principals.track('sessions', sessions),
      principals.track('memberships', memberships),
      principals.track('sessionTokens', sessionTokens),
      principals.track('activity', activity),
      denylist,
    );
  });

  const command = (tenantId = TO) =>
    new SwitchTenantCommand(user.id, tenantId, REFRESH, access, { ip: '10.0.0.1' });

  it('rotates the session into the target tenant with its roles and denylists the old access token', async () => {
    await expect(run(command())).resolves.toBe(tokens);
    expect(log).toEqual(['deny', 'begin', 'rotate', 'touch', 'open', 'commit']);
    expect(denylist.deny).toHaveBeenCalledWith('access-jti', 1_900_000_000);
    const [input] = sessionTokens.openIf.mock.calls[0] ?? [];
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
    expect(activity.touch).toHaveBeenCalledWith(TO, user.id, expect.any(Date));
  });

  it('reads the target as the caller, then rotates, touches and opens as { user, target, roles }', async () => {
    await run(command());
    expect(principals.summary()).toEqual([
      ['memberships.find', user.id, FROM],
      ['users.findById', user.id, FROM],
      ['sessionTokens.openIf', user.id, FROM],
      ['sessions.revokeForRotation', user.id, TO],
      ['activity.touch', user.id, TO],
    ]);
    expect(principals.calls.at(-1)?.principal?.roles).toEqual(['member']);
  });

  it('refuses a call without the caller principal, or as another user, before any lookup', async () => {
    await expect(handler.execute(command())).rejects.toBeInstanceOf(UnauthenticatedException);
    await expect(
      runWithPrincipal(
        createPrincipal({ userId: '0190f3b2-0000-7000-8000-0000000000ff', tenantId: FROM }),
        () => handler.execute(command()),
      ),
    ).rejects.toBeInstanceOf(TenantAccessDeniedException);
    expect(principals.calls).toEqual([]);
    expect(log).toEqual([]);
  });

  it.each([
    ['a tenant the user is not a member of', '0190f3b2-0000-7000-8000-0000000000bb'],
    ['the platform tenant', PLATFORM_TENANT_ID],
    ['a malformed id', 'nope'],
  ])(
    '%s → 403 TENANT_ACCESS_DENIED; nothing rotated or denylisted (Review Focus 1)',
    async (_name, tenantId) => {
      await expect(run(command(tenantId))).rejects.toBeInstanceOf(TenantAccessDeniedException);
      expect(log).toEqual([]);
    },
  );

  it("someone else's refresh token → 401 INVALID_REFRESH_TOKEN before any lookup", async () => {
    issuer.verifyRefreshToken.mockResolvedValue({
      ...claims,
      sub: '0190f3b2-0000-7000-8000-0000000000ff',
    });
    await expect(run(command())).rejects.toBeInstanceOf(InvalidRefreshTokenException);
    expect(memberships.find).not.toHaveBeenCalled();
  });

  it('a reused (already rotated) refresh token revokes every session: 401 REFRESH_TOKEN_REUSED', async () => {
    sessions.revokeForRotation.mockResolvedValue(false);
    sessions.findById.mockResolvedValue(session({ revokedAt: new Date() }));
    await expect(run(command())).rejects.toBeInstanceOf(RefreshTokenReuseDetectedException);
    expect(sessions.findById).toHaveBeenCalledWith(user.id, sessionId);
    expect(sessions.revokeForRotation).toHaveBeenCalledOnce();
    expect(activity.touch).not.toHaveBeenCalled();
    expect(log).toEqual(['deny', 'begin', 'commit', 'revoke-all']);
    expect(principals.summary().at(-1)).toEqual(['sessions.revokeAllForUser', user.id, FROM]);
  });
});

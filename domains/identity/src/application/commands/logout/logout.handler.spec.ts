import { Logger } from '@nestjs/common';
import type { AccessTokenDenylist } from '@platform/auth';
import { UnauthenticatedException } from '@platform/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockOf } from '../../../../test/mocks.js';
import type { TokenIssuer } from '../../../infrastructure/security/token-issuer.service.js';
import type { SessionsRepository } from '../../persistence/sessions.repository.js';
import { LogoutCommand } from './logout.command.js';
import { LogoutHandler } from './logout.handler.js';

describe('LogoutHandler', () => {
  let denylist: ReturnType<typeof mockOf<AccessTokenDenylist>>;
  let tokens: ReturnType<typeof mockOf<TokenIssuer>>;
  let sessions: ReturnType<typeof mockOf<SessionsRepository>>;
  let handler: LogoutHandler;

  beforeEach(() => {
    denylist = mockOf<AccessTokenDenylist>({ deny: async () => undefined });
    tokens = mockOf<TokenIssuer>({
      verifyRefreshToken: async () => ({
        sub: 'u-1',
        jti: 's-9',
        typ: 'refresh' as const,
        iat: 1,
        exp: 2,
        iss: 'i',
        aud: 'a',
      }),
    });
    sessions = mockOf<SessionsRepository>({
      revoke: async () => true,
      revokeAllForUser: async () => 2,
    });
    handler = new LogoutHandler(denylist, tokens, sessions);
  });

  it('denylists the access token and revokes the session of the refresh token', async () => {
    await handler.execute(new LogoutCommand('u-1', 'jti-1', 1_900_000_000, 'refresh.jwt'));

    expect(denylist.deny).toHaveBeenCalledWith('jti-1', 1_900_000_000);
    expect(sessions.revoke).toHaveBeenCalledWith({
      id: 's-9',
      userId: 'u-1',
      now: expect.any(Date),
    });
    expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
  });

  it('without a refresh token: signs out of every session', async () => {
    const debug = vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    await handler.execute(new LogoutCommand('u-1', 'jti-1', 1_900_000_000));
    expect(denylist.deny).toHaveBeenCalledOnce();
    expect(sessions.revokeAllForUser).toHaveBeenCalledWith('u-1', expect.any(Date));
    expect(debug).toHaveBeenCalledExactlyOnceWith(
      { userId: 'u-1', revoked: 2 },
      'Signed out of every session',
    );
  });

  it("is lenient: a garbage or someone else's refresh token revokes nothing and does not fail", async () => {
    tokens.verifyRefreshToken.mockRejectedValueOnce(new UnauthenticatedException('bad'));
    await expect(
      handler.execute(new LogoutCommand('u-1', 'jti-1', 1_900_000_000, 'garbage')),
    ).resolves.toBeUndefined();

    await handler.execute(new LogoutCommand('u-2', 'jti-2', 1_900_000_000, 'refresh.jwt'));

    expect(sessions.revoke).not.toHaveBeenCalled();
    expect(denylist.deny).toHaveBeenCalledTimes(2);
  });
});

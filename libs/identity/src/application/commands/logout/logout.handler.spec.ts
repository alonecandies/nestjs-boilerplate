import type { AccessTokenDenylist, TokenService } from '@app/auth';
import { UnauthenticatedException } from '@app/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { mockOf } from '../../../../test/mocks.js';
import type { SessionsRepository } from '../../persistence/sessions.repository.js';
import { LogoutCommand } from './logout.command.js';
import { LogoutHandler } from './logout.handler.js';

describe('LogoutHandler', () => {
  let denylist: ReturnType<typeof mockOf<AccessTokenDenylist>>;
  let tokens: ReturnType<typeof mockOf<TokenService>>;
  let sessions: ReturnType<typeof mockOf<SessionsRepository>>;
  let handler: LogoutHandler;

  beforeEach(() => {
    denylist = mockOf<AccessTokenDenylist>({ deny: async () => undefined });
    tokens = mockOf<TokenService>({
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
    await handler.execute(new LogoutCommand('u-1', 'jti-1', 1_900_000_000));
    expect(denylist.deny).toHaveBeenCalledOnce();
    expect(sessions.revokeAllForUser).toHaveBeenCalledWith('u-1', expect.any(Date));
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

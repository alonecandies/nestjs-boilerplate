import type { PasswordHasher } from '@app/auth';
import { beforeEach, describe, expect, it } from 'vitest';
import { makeAuthTokens, makeUserSnapshot } from '../../../../test/fixtures.js';
import { mockOf } from '../../../../test/mocks.js';
import { InvalidCredentialsException } from '../../../domain/identity.errors.js';
import type { UsersRepository } from '../../persistence/users.repository.js';
import type { SessionTokensService } from '../../services/session-tokens.service.js';
import { LoginCommand } from './login.command.js';
import { LoginHandler } from './login.handler.js';

describe('LoginHandler', () => {
  const tokens = makeAuthTokens();
  const stored = makeUserSnapshot();
  let users: ReturnType<typeof mockOf<UsersRepository>>;
  let hasher: ReturnType<typeof mockOf<PasswordHasher>>;
  let sessionTokens: ReturnType<typeof mockOf<SessionTokensService>>;
  let handler: LoginHandler;

  beforeEach(() => {
    users = mockOf<UsersRepository>({
      findCredentialsByEmail: async () => stored,
      updatePasswordHash: async () => undefined,
    });
    hasher = mockOf<PasswordHasher>({
      verify: async () => true,
      verifyDummy: async () => false,
      needsRehash: () => false,
      hash: async () => '$argon2id$new',
    });
    sessionTokens = mockOf<SessionTokensService>({ open: async () => tokens });
    handler = new LoginHandler(users, hasher, sessionTokens);
  });

  it('verifies the password and opens a session (hash never passed on)', async () => {
    const client = { ip: '10.0.0.9' };
    await expect(handler.execute(new LoginCommand(' ADA@example.com', 'pw', client))).resolves.toBe(
      tokens,
    );

    expect(users.findCredentialsByEmail).toHaveBeenCalledWith('ada@example.com');
    expect(hasher.verify).toHaveBeenCalledWith(stored.passwordHash, 'pw');
    const [record, passedClient] = sessionTokens.open.mock.calls[0] ?? [];
    expect(record).not.toHaveProperty('passwordHash');
    expect(record).toMatchObject({ id: stored.id });
    expect(passedClient).toBe(client);
    expect(users.updatePasswordHash).not.toHaveBeenCalled();
  });

  it('unknown email: burns a dummy verification, then the same 401 as a wrong password', async () => {
    users.findCredentialsByEmail.mockResolvedValue(null);
    await expect(handler.execute(new LoginCommand('who@x.io', 'pw'))).rejects.toBeInstanceOf(
      InvalidCredentialsException,
    );
    expect(hasher.verifyDummy).toHaveBeenCalledWith('pw');
    expect(sessionTokens.open).not.toHaveBeenCalled();
  });

  it('wrong password → InvalidCredentialsException, no session', async () => {
    hasher.verify.mockResolvedValue(false);
    const error = await handler
      .execute(new LoginCommand('ada@example.com', 'bad'))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidCredentialsException);
    expect(error).toMatchObject({ code: 'INVALID_CREDENTIALS', httpStatus: 401 });
    expect(sessionTokens.open).not.toHaveBeenCalled();
  });

  it('re-hashes with the current argon2 parameters; a failure there never fails the login', async () => {
    hasher.needsRehash.mockReturnValue(true);
    await handler.execute(new LoginCommand('ada@example.com', 'pw'));
    expect(users.updatePasswordHash).toHaveBeenCalledWith(
      stored.id,
      '$argon2id$new',
      expect.any(Date),
    );

    users.updatePasswordHash.mockRejectedValue(new Error('db down'));
    await expect(handler.execute(new LoginCommand('ada@example.com', 'pw'))).resolves.toBe(tokens);
  });
});

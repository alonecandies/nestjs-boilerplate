import { Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  makeAuthTokens,
  makeUserSnapshot,
  passThroughTransaction,
} from '../../../../test/fixtures.js';
import { mockOf } from '../../../../test/mocks.js';
import {
  InvalidCredentialsException,
  TenantAccessDeniedException,
} from '../../../domain/identity.errors.js';
import type { PasswordHasher } from '../../../infrastructure/security/password-hasher.service.js';
import type { MembershipRecord } from '../../persistence/memberships.repository.js';
import type { UsersRepository } from '../../persistence/users.repository.js';
import type { SessionTokensService } from '../../services/session-tokens.service.js';
import type { TenantSelection } from '../../services/tenant-selection.service.js';
import { LoginCommand } from './login.command.js';
import { LoginHandler } from './login.handler.js';

const TENANT = '0190f3b2-0000-7000-8000-0000000000aa';

describe('LoginHandler', () => {
  const tokens = makeAuthTokens();
  const stored = makeUserSnapshot();
  const membership: MembershipRecord = {
    tenantId: TENANT,
    userId: stored.id,
    roles: ['admin'],
    lastActiveAt: new Date(),
    createdAt: new Date(),
  };
  let users: ReturnType<typeof mockOf<UsersRepository>>;
  let hasher: ReturnType<typeof mockOf<PasswordHasher>>;
  let sessionTokens: ReturnType<typeof mockOf<SessionTokensService>>;
  let selection: ReturnType<typeof mockOf<TenantSelection>>;
  let transaction: ReturnType<typeof passThroughTransaction>;
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
    selection = mockOf<TenantSelection>({ forLogin: async () => membership });
    transaction = passThroughTransaction();
    handler = new LoginHandler(users, hasher, sessionTokens, transaction, selection);
  });

  it('verifies the password, picks the tenant, opens a session there (hash never passed on)', async () => {
    const client = { ip: '10.0.0.9' };
    await expect(
      handler.execute(new LoginCommand(' Ada@Example.com ', 'pw', client, TENANT)),
    ).resolves.toBe(tokens);

    expect(users.findCredentialsByEmail).toHaveBeenCalledWith('ada@example.com');
    expect(hasher.verify).toHaveBeenCalledWith(stored.passwordHash, 'pw');
    const [user, tenantId] = selection.forLogin.mock.calls[0] ?? [];
    expect(user).not.toHaveProperty('passwordHash');
    expect(tenantId).toBe(TENANT);
    const [input] = sessionTokens.open.mock.calls[0] ?? [];
    expect(input).toEqual({ user, tenantId: TENANT, roles: ['admin'], client });
    expect(transaction.runs).toBe(1);
  });

  it('a tenant the user may not use fails AFTER the password check (a thrown failure: C wave-1 contract)', async () => {
    selection.forLogin.mockRejectedValue(new TenantAccessDeniedException());
    await expect(
      handler.execute(new LoginCommand('ada@example.com', 'pw', undefined, TENANT)),
    ).rejects.toBeInstanceOf(TenantAccessDeniedException);
    expect(hasher.verify).toHaveBeenCalled();
    expect(sessionTokens.open).not.toHaveBeenCalled();
  });

  it('unknown email: burns a dummy verification, then the same 401 as a wrong password', async () => {
    users.findCredentialsByEmail.mockResolvedValue(null);
    await expect(
      handler.execute(new LoginCommand('nobody@example.com', 'pw')),
    ).rejects.toBeInstanceOf(InvalidCredentialsException);
    expect(hasher.verifyDummy).toHaveBeenCalledWith('pw');
    expect(selection.forLogin).not.toHaveBeenCalled();
  });

  it('wrong password → InvalidCredentialsException, no tenant picked, no session', async () => {
    hasher.verify.mockResolvedValue(false);
    await expect(
      handler.execute(new LoginCommand('ada@example.com', 'bad')),
    ).rejects.toBeInstanceOf(InvalidCredentialsException);
    expect(selection.forLogin).not.toHaveBeenCalled();
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

    const failure = new Error('db down');
    users.updatePasswordHash.mockRejectedValue(failure);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await expect(handler.execute(new LoginCommand('ada@example.com', 'pw'))).resolves.toBe(tokens);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      { err: failure, userId: stored.id },
      'Password re-hash failed',
    );
  });
});

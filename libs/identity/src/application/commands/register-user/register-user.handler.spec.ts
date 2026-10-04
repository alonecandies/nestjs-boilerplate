import type { PasswordHasher } from '@app/auth';
import { beforeEach, describe, expect, it } from 'vitest';
import { recordingPublisher } from '../../../../test/cqrs-fakes.js';
import { makeAuthTokens, passThroughTransaction } from '../../../../test/fixtures.js';
import { mockOf } from '../../../../test/mocks.js';
import { UserRegisteredEvent } from '../../../domain/events/user-registered.event.js';
import { EmailAlreadyTakenException } from '../../../domain/identity.errors.js';
import type { UserAggregate } from '../../../domain/user.aggregate.js';
import type { UsersRepository } from '../../persistence/users.repository.js';
import type { SessionTokensService } from '../../services/session-tokens.service.js';
import { RegisterUserCommand } from './register-user.command.js';
import { RegisterUserHandler } from './register-user.handler.js';

describe('RegisterUserHandler', () => {
  const tokens = makeAuthTokens();
  let users: ReturnType<typeof mockOf<UsersRepository>>;
  let hasher: ReturnType<typeof mockOf<PasswordHasher>>;
  let sessionTokens: ReturnType<typeof mockOf<SessionTokensService>>;
  let transaction: ReturnType<typeof passThroughTransaction>;
  let events: ReturnType<typeof recordingPublisher>;
  let handler: RegisterUserHandler;
  const order: string[] = [];

  beforeEach(() => {
    order.length = 0;
    users = mockOf<UsersRepository>({
      existsByEmail: async () => false,
      insert: async () => {
        order.push('insert');
      },
    });
    hasher = mockOf<PasswordHasher>({ hash: async () => '$argon2id$hash' });
    sessionTokens = mockOf<SessionTokensService>({
      open: async () => {
        order.push('open-session');
        return tokens;
      },
    });
    transaction = passThroughTransaction();
    events = recordingPublisher();
    handler = new RegisterUserHandler(users, hasher, sessionTokens, transaction, events.publisher);
  });

  const command = new RegisterUserCommand(' Ada@Example.com ', 'correct horse', ' Ada ', {
    userAgent: 'jest',
  });

  it('hashes, inserts the user and its first session in ONE transaction, then publishes', async () => {
    await expect(handler.execute(command)).resolves.toBe(tokens);

    expect(users.existsByEmail).toHaveBeenCalledWith('ada@example.com');
    expect(hasher.hash).toHaveBeenCalledWith('correct horse');
    expect(transaction.runs).toBe(1);
    expect(order).toEqual(['insert', 'open-session']);

    const inserted = users.insert.mock.calls[0]?.[0] as UserAggregate;
    expect(inserted.toSnapshot()).toMatchObject({
      email: 'ada@example.com',
      displayName: 'Ada',
      passwordHash: '$argon2id$hash',
      roles: ['user'],
    });
    const [record, client] = sessionTokens.open.mock.calls[0] ?? [];
    expect(record).not.toHaveProperty('passwordHash');
    expect(record).toMatchObject({ id: inserted.id, email: 'ada@example.com' });
    expect(client).toEqual({ userAgent: 'jest' });

    expect(events.published).toHaveLength(1);
    expect(events.published[0]).toBeInstanceOf(UserRegisteredEvent);
    expect(events.published[0]).toMatchObject({ userId: inserted.id, email: 'ada@example.com' });
  });

  it('rejects a taken email before spending an argon2 hash', async () => {
    users.existsByEmail.mockResolvedValue(true);
    await expect(handler.execute(command)).rejects.toBeInstanceOf(EmailAlreadyTakenException);
    expect(hasher.hash).not.toHaveBeenCalled();
    expect(users.insert).not.toHaveBeenCalled();
  });

  it('publishes nothing when the transaction fails (e.g. the unique constraint lost a race)', async () => {
    users.insert.mockRejectedValue(new EmailAlreadyTakenException());
    await expect(handler.execute(command)).rejects.toBeInstanceOf(EmailAlreadyTakenException);
    expect(sessionTokens.open).not.toHaveBeenCalled();
    expect(events.published).toEqual([]);
  });
});

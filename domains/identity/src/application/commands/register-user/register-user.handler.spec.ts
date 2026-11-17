import { runWithPrincipal } from '@platform/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { recordingPublisher } from '../../../../test/cqrs-fakes.js';
import { makeAuthTokens } from '../../../../test/fixtures.js';
import { mockOf } from '../../../../test/mocks.js';
import { principalLog } from '../../../../test/principal-log.js';
import { MembershipCreatedEvent } from '../../../domain/events/membership-created.event.js';
import { UserRegisteredEvent } from '../../../domain/events/user-registered.event.js';
import { EmailAlreadyTakenException } from '../../../domain/identity.errors.js';
import type { UserAggregate } from '../../../domain/user.aggregate.js';
import type { PasswordHasher } from '../../../infrastructure/security/password-hasher.service.js';
import type { NewTenant } from '../../persistence/tenants.repository.js';
import type { UsersRepository } from '../../persistence/users.repository.js';
import type { UsersSystemRepository } from '../../persistence/users.system-repository.js';
import type { PersonalWorkspaces } from '../../services/personal-workspaces.service.js';
import {
  type OpenSessionInput,
  type SessionTokensService,
  sessionPrincipal,
} from '../../services/session-tokens.service.js';
import type { TenantBootstrap } from '../../services/tenant-bootstrap.elevated.js';
import { RegisterUserCommand } from './register-user.command.js';
import { RegisterUserHandler } from './register-user.handler.js';

const WORKSPACE: NewTenant = {
  id: '0190f3b2-0000-7000-8000-0000000000cc',
  slug: 'ada-000000cc',
  name: "Ada's workspace",
  personal: true,
};

describe('RegisterUserHandler', () => {
  const tokens = makeAuthTokens();
  let users: ReturnType<typeof mockOf<UsersRepository>>;
  let usersSystem: ReturnType<typeof mockOf<UsersSystemRepository>>;
  let hasher: ReturnType<typeof mockOf<PasswordHasher>>;
  let sessionTokens: ReturnType<typeof mockOf<SessionTokensService>>;
  let events: ReturnType<typeof recordingPublisher>;
  let workspaces: ReturnType<typeof mockOf<PersonalWorkspaces>>;
  let bootstrap: ReturnType<typeof mockOf<TenantBootstrap>>;
  let log: ReturnType<typeof principalLog>;
  let handler: RegisterUserHandler;
  const order: string[] = [];

  beforeEach(() => {
    order.length = 0;
    usersSystem = mockOf<UsersSystemRepository>({ existsByEmail: async () => false });
    users = mockOf<UsersRepository>({
      insert: async () => {
        order.push('insert-user');
      },
    });
    hasher = mockOf<PasswordHasher>({
      hash: async () => {
        order.push('hash');
        return '$argon2id$hash';
      },
    });
    // The real service: ONE unit of work as the session's principal, `before` first (its spec).
    sessionTokens = mockOf<SessionTokensService>({
      open: (input: OpenSessionInput, before?: () => Promise<void>) =>
        runWithPrincipal(sessionPrincipal(input), async () => {
          order.push('begin');
          await before?.();
          order.push('insert-session');
          return tokens;
        }),
    });
    events = recordingPublisher();
    workspaces = mockOf<PersonalWorkspaces>({
      plan: (_user: unknown, id: string) => {
        order.push('plan-workspace');
        return { ...WORKSPACE, id };
      },
    });
    bootstrap = mockOf<TenantBootstrap>({
      create: async () => {
        order.push('bootstrap');
      },
    });
    log = principalLog();
    handler = new RegisterUserHandler(
      log.track('users', users),
      log.track('usersSystem', usersSystem),
      hasher,
      log.track('sessionTokens', sessionTokens),
      events.publisher,
      workspaces,
      log.track('bootstrap', bootstrap),
      events.eventBus,
    );
  });

  const command = new RegisterUserCommand(' Ada@Example.com ', 'correct horse', ' Ada ', {
    userAgent: 'jest',
  });

  it('hashes and plans the ids first, then user, workspace and session in ONE unit of work, then publishes', async () => {
    await expect(handler.execute(command)).resolves.toBe(tokens);

    expect(usersSystem.existsByEmail).toHaveBeenCalledWith('ada@example.com');
    expect(hasher.hash).toHaveBeenCalledWith('correct horse');
    expect(order).toEqual([
      'hash',
      'plan-workspace',
      'begin',
      'insert-user',
      'bootstrap',
      'insert-session',
    ]);

    const inserted = users.insert.mock.calls[0]?.[0] as UserAggregate;
    expect(inserted.toSnapshot()).toMatchObject({
      email: 'ada@example.com',
      displayName: 'Ada',
      passwordHash: '$argon2id$hash',
      isPlatformStaff: false,
    });
    const [registered, created] = events.published as [UserRegisteredEvent, MembershipCreatedEvent];
    expect(workspaces.plan).toHaveBeenCalledWith(
      expect.objectContaining({ id: inserted.id, email: 'ada@example.com', displayName: 'Ada' }),
      registered.tenantId,
    );
    const workspace = { ...WORKSPACE, id: registered.tenantId };
    expect(bootstrap.create).toHaveBeenCalledWith(
      workspace,
      inserted.id,
      inserted.toSnapshot().createdAt,
    );
    const [input] = sessionTokens.open.mock.calls[0] ?? [];
    expect(input?.user).not.toHaveProperty('passwordHash');
    expect(input).toMatchObject({
      user: { id: inserted.id, email: 'ada@example.com' },
      tenantId: workspace.id,
      roles: ['owner'],
      client: { userAgent: 'jest' },
    });

    // After the commit: the user and their personal-workspace membership, both in that workspace.
    expect(events.published).toHaveLength(2);
    expect(registered).toBeInstanceOf(UserRegisteredEvent);
    expect(registered).toMatchObject({ userId: inserted.id, email: 'ada@example.com' });
    expect(registered.tenantId).toMatch(/^[0-9a-f-]{36}$/);
    expect(created).toBeInstanceOf(MembershipCreatedEvent);
    expect(created).toMatchObject({
      tenantId: registered.tenantId,
      userId: inserted.id,
      email: 'ada@example.com',
      displayName: 'Ada',
      actorId: inserted.id,
      occurredAt: inserted.toSnapshot().createdAt,
    });
  });

  it('no repository write happens before the { newUser, newTenant, owner } principal is set', async () => {
    await handler.execute(command);
    const userId = users.insert.mock.calls[0]?.[0].id;
    const workspaceId = bootstrap.create.mock.calls[0]?.[0].id;
    expect(log.summary()).toEqual([
      ['usersSystem.existsByEmail', null, null],
      ['sessionTokens.open', null, null],
      ['users.insert', userId, workspaceId],
      ['bootstrap.create', userId, workspaceId],
    ]);
    expect(log.calls.at(-1)?.principal?.roles).toEqual(['owner']);
  });

  it('rejects a taken email before spending an argon2 hash', async () => {
    usersSystem.existsByEmail.mockResolvedValue(true);
    await expect(handler.execute(command)).rejects.toBeInstanceOf(EmailAlreadyTakenException);
    expect(hasher.hash).not.toHaveBeenCalled();
    expect(users.insert).not.toHaveBeenCalled();
  });

  it('publishes nothing when the transaction fails (e.g. the unique constraint lost a race)', async () => {
    users.insert.mockRejectedValue(new EmailAlreadyTakenException());
    await expect(handler.execute(command)).rejects.toBeInstanceOf(EmailAlreadyTakenException);
    expect(bootstrap.create).not.toHaveBeenCalled();
    expect(events.published).toEqual([]);
  });
});

import { MEMBERSHIP_CREATED_EVENT, USER_REGISTERED_EVENT } from '@domain/identity-contracts';
import { runWithPrincipal } from '@platform/common';
import { parseEventEnvelope } from '@platform/contracts';
import type { OutboxRecord } from '@platform/outbox';
import { InMemoryOutbox } from '@platform/outbox/testing';
import { FakeKafkaProducer } from '@platform/transport/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { recordingPublisher } from '../../../../test/cqrs-fakes.js';
import { makeAuthTokens } from '../../../../test/fixtures.js';
import { mockOf } from '../../../../test/mocks.js';
import { principalLog } from '../../../../test/principal-log.js';
import { MembershipCreatedEvent } from '../../../domain/events/membership-created.event.js';
import { UserRegisteredEvent } from '../../../domain/events/user-registered.event.js';
import { EmailAlreadyTakenException } from '../../../domain/identity.errors.js';
import type { UserAggregate } from '../../../domain/user.aggregate.js';
import { IDENTITY_OUTBOX } from '../../../infrastructure/persistence/identity-outbox.js';
import type { PasswordHasher } from '../../../infrastructure/security/password-hasher.service.js';
import type { NewTenant } from '../../persistence/tenants.repository.js';
import type { UsersRepository } from '../../persistence/users.repository.js';
import type { UsersSystemRepository } from '../../persistence/users.system-repository.js';
import { IdentityIntegrationEvents } from '../../services/identity-integration-events.service.js';
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

/** The in-memory identity outbox; each INSERT is logged in `order` (or fails when told to). */
class OrderedOutbox extends InMemoryOutbox {
  failWith: Error | undefined;

  constructor(
    private readonly order: string[],
    kafka: FakeKafkaProducer,
  ) {
    super(IDENTITY_OUTBOX, { kafka });
  }

  protected override async insert(record: OutboxRecord): Promise<void> {
    this.order.push(`enqueue:${record.topic}`);
    if (this.failWith !== undefined) throw this.failWith;
    await super.insert(record);
  }
}

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
  let kafka: FakeKafkaProducer;
  let outbox: OrderedOutbox;
  let handler: RegisterUserHandler;
  const order: string[] = [];

  beforeEach(() => {
    order.length = 0;
    kafka = new FakeKafkaProducer({ source: 'identity-service' });
    outbox = new OrderedOutbox(order, kafka);
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
          order.push('commit');
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
      new IdentityIntegrationEvents(outbox),
    );
  });

  const command = new RegisterUserCommand(' Ada@Example.com ', 'correct horse', ' Ada ', {
    userAgent: 'jest',
  });

  it('hashes and plans the ids first, then user, workspace, outbox rows and session in ONE unit of work, then publishes in process', async () => {
    await expect(handler.execute(command)).resolves.toBe(tokens);

    expect(usersSystem.existsByEmail).toHaveBeenCalledWith('ada@example.com');
    expect(hasher.hash).toHaveBeenCalledWith('correct horse');
    expect(order).toEqual([
      'hash',
      'plan-workspace',
      'begin',
      'insert-user',
      'bootstrap',
      `enqueue:${USER_REGISTERED_EVENT.topic}`,
      `enqueue:${MEMBERSHIP_CREATED_EVENT.topic}`,
      'insert-session',
      'commit',
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

  it('enqueues identity.user-registered.v1 in the unit of work: key and actor = the user, id and occurredAt = the domain event, tenant = the workspace; nothing goes to Kafka', async () => {
    await handler.execute(command);
    const [registered, created] = events.published as [UserRegisteredEvent, MembershipCreatedEvent];
    const inserted = users.insert.mock.calls[0]?.[0] as UserAggregate;

    const rows = outbox.records.filter((row) => row.topic === USER_REGISTERED_EVENT.topic);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row).toMatchObject({
      tenantId: registered.tenantId,
      id: registered.eventId,
      key: registered.userId,
      publishedAt: null,
    });
    expect(parseEventEnvelope(USER_REGISTERED_EVENT, row?.envelope)).toMatchObject({
      id: registered.eventId,
      type: USER_REGISTERED_EVENT.topic,
      occurredAt: registered.occurredAt.toISOString(),
      tenantId: registered.tenantId,
      actorId: registered.userId,
      payload: {
        userId: registered.userId,
        email: 'ada@example.com',
        displayName: 'Ada',
        registeredAt: registered.occurredAt.toISOString(),
      },
    });
    // The personal-workspace membership rides the same unit of work, with the in-process event's id.
    expect(outbox.records.map((r) => [r.topic, r.id, r.tenantId, r.key])).toEqual([
      [USER_REGISTERED_EVENT.topic, registered.eventId, registered.tenantId, registered.userId],
      [MEMBERSHIP_CREATED_EVENT.topic, created.eventId, registered.tenantId, registered.userId],
    ]);
    expect(registered.userId).toBe(inserted.id);
    expect(kafka.records).toEqual([]);
  });

  it('a failing enqueue rejects the registration: no session, nothing published in process', async () => {
    outbox.failWith = new Error('outbox insert failed');
    await expect(handler.execute(command)).rejects.toThrow('outbox insert failed');
    expect(order).not.toContain('insert-session');
    expect(order).not.toContain('commit');
    expect(events.published).toEqual([]);
    expect(outbox.records).toEqual([]);
    expect(kafka.records).toEqual([]);
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
    expect(outbox.records).toEqual([]);
  });
});

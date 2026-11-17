import { Logger } from '@nestjs/common';
import { getPrincipal, runWithPrincipal } from '@platform/common';
import type { RlsElevation } from '@platform/database';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { recordingEventBus } from '../../../../test/cqrs-fakes.js';
import { makeAuthTokens, makeUserSnapshot } from '../../../../test/fixtures.js';
import { mockOf } from '../../../../test/mocks.js';
import { principalLog } from '../../../../test/principal-log.js';
import { MembershipCreatedEvent } from '../../../domain/events/membership-created.event.js';
import {
  InvalidCredentialsException,
  TenantAccessDeniedException,
} from '../../../domain/identity.errors.js';
import type { PasswordHasher } from '../../../infrastructure/security/password-hasher.service.js';
import { createInMemoryIdentityPersistence } from '../../../testing/in-memory-identity.js';
import type { MembershipRecord } from '../../persistence/memberships.repository.js';
import type { NewTenant } from '../../persistence/tenants.repository.js';
import type { UsersRepository } from '../../persistence/users.repository.js';
import type { UsersSystemRepository } from '../../persistence/users.system-repository.js';
import { MembershipActivity } from '../../services/membership-activity.elevated.js';
import type { PersonalWorkspaces } from '../../services/personal-workspaces.service.js';
import {
  type OpenSessionInput,
  type SessionTokensService,
  sessionPrincipal,
} from '../../services/session-tokens.service.js';
import type { TenantBootstrap } from '../../services/tenant-bootstrap.elevated.js';
import type { TenantSelection } from '../../services/tenant-selection.service.js';
import { LoginCommand } from './login.command.js';
import { LoginHandler } from './login.handler.js';

const TENANT = '0190f3b2-0000-7000-8000-0000000000aa';
const WORKSPACE: NewTenant = {
  id: '0190f3b2-0000-7000-8000-0000000000cc',
  slug: 'ada-000000cc',
  name: "Ada's workspace",
  personal: true,
};

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
  let usersSystem: ReturnType<typeof mockOf<UsersSystemRepository>>;
  let hasher: ReturnType<typeof mockOf<PasswordHasher>>;
  let sessionTokens: ReturnType<typeof mockOf<SessionTokensService>>;
  let selection: ReturnType<typeof mockOf<TenantSelection>>;
  let workspaces: ReturnType<typeof mockOf<PersonalWorkspaces>>;
  let bootstrap: ReturnType<typeof mockOf<TenantBootstrap>>;
  let activity: ReturnType<typeof mockOf<MembershipActivity>>;
  let log: ReturnType<typeof principalLog>;
  let events: ReturnType<typeof recordingEventBus>;
  let handler: LoginHandler;

  beforeEach(() => {
    users = mockOf<UsersRepository>({ updatePasswordHash: async () => undefined });
    usersSystem = mockOf<UsersSystemRepository>({ findCredentialsByEmail: async () => stored });
    hasher = mockOf<PasswordHasher>({
      verify: async () => true,
      verifyDummy: async () => false,
      needsRehash: () => false,
      hash: async () => '$argon2id$new',
    });
    // The real service runs `before` in its unit of work, as the session's principal (its spec).
    sessionTokens = mockOf<SessionTokensService>({
      open: (input: OpenSessionInput, before?: () => Promise<void>) =>
        runWithPrincipal(sessionPrincipal(input), async () => {
          await before?.();
          return tokens;
        }),
    });
    selection = mockOf<TenantSelection>({ forLogin: async () => membership });
    workspaces = mockOf<PersonalWorkspaces>({ plan: () => WORKSPACE });
    bootstrap = mockOf<TenantBootstrap>({ create: async () => undefined });
    activity = mockOf<MembershipActivity>({ touch: async () => undefined });
    log = principalLog();
    events = recordingEventBus();
    handler = new LoginHandler(
      log.track('users', users),
      log.track('usersSystem', usersSystem),
      hasher,
      log.track('sessionTokens', sessionTokens),
      log.track('selection', selection),
      workspaces,
      log.track('bootstrap', bootstrap),
      log.track('activity', activity),
      events.eventBus,
    );
  });

  it('verifies the password, picks the tenant, then touches and opens the session there', async () => {
    const client = { ip: '10.0.0.9' };
    await expect(
      handler.execute(new LoginCommand(' Ada@Example.com ', 'pw', client, TENANT)),
    ).resolves.toBe(tokens);

    expect(usersSystem.findCredentialsByEmail).toHaveBeenCalledWith('ada@example.com');
    expect(hasher.verify).toHaveBeenCalledWith(stored.passwordHash, 'pw');
    const [user, tenantId] = selection.forLogin.mock.calls[0] ?? [];
    expect(user).not.toHaveProperty('passwordHash');
    expect(tenantId).toBe(TENANT);
    const [input] = sessionTokens.open.mock.calls[0] ?? [];
    expect(input).toEqual({ user, tenantId: TENANT, roles: ['admin'], client });
    expect(activity.touch).toHaveBeenCalledWith(TENANT, stored.id, expect.any(Date));
    expect(bootstrap.create).not.toHaveBeenCalled();
    expect(events.published).toEqual([]);
  });

  it('a login that created the personal workspace publishes its membership after the commit', async () => {
    selection.forLogin.mockResolvedValue(null);
    bootstrap.create.mockImplementation(async () => {
      expect(events.published).toEqual([]); // still inside the unit of work
    });

    await expect(handler.execute(new LoginCommand('ada@example.com', 'pw'))).resolves.toBe(tokens);

    expect(events.published).toHaveLength(1);
    expect(events.published[0]).toBeInstanceOf(MembershipCreatedEvent);
    expect(events.published[0]).toMatchObject({
      tenantId: WORKSPACE.id,
      userId: stored.id,
      email: stored.email,
      displayName: stored.displayName,
      actorId: stored.id,
    });
  });

  it('publishes nothing when the session cannot be opened', async () => {
    selection.forLogin.mockResolvedValue(null);
    sessionTokens.open.mockRejectedValue(new Error('db down'));
    await expect(handler.execute(new LoginCommand('ada@example.com', 'pw'))).rejects.toThrow();
    expect(events.published).toEqual([]);
  });

  it('runs each call under the principal of its unit of work (flow table: pre-auth → {user, null} → session)', async () => {
    hasher.needsRehash.mockReturnValue(true);
    await handler.execute(new LoginCommand('ada@example.com', 'pw'));
    expect(log.summary()).toEqual([
      ['usersSystem.findCredentialsByEmail', null, null],
      ['users.updatePasswordHash', stored.id, null],
      ['selection.forLogin', stored.id, null],
      ['sessionTokens.open', null, null],
      // `before` of the session's unit of work: as { user, tenant, roles }.
      ['activity.touch', stored.id, TENANT],
    ]);
  });

  it('a pre-tenancy account: the workspace id is planned first, then bootstrapped in the session unit', async () => {
    selection.forLogin.mockResolvedValue(null);
    await handler.execute(new LoginCommand('ada@example.com', 'pw', undefined));
    expect(workspaces.plan).toHaveBeenCalledBefore(sessionTokens.open);
    const [input] = sessionTokens.open.mock.calls[0] ?? [];
    expect(input).toMatchObject({ tenantId: WORKSPACE.id, roles: ['owner'] });
    expect(bootstrap.create).toHaveBeenCalledWith(WORKSPACE, stored.id, expect.any(Date));
    expect(log.calls.find((c) => c.call === 'bootstrap.create')?.principal).toEqual({
      userId: stored.id,
      tenantId: WORKSPACE.id,
      roles: ['owner'],
      staff: false,
    });
    expect(activity.touch).not.toHaveBeenCalled();
  });

  it('a tenant the user may not use fails AFTER the password check (a thrown failure: C wave-1 contract)', async () => {
    selection.forLogin.mockRejectedValue(new TenantAccessDeniedException());
    await expect(
      handler.execute(new LoginCommand('ada@example.com', 'pw', undefined, TENANT)),
    ).rejects.toBeInstanceOf(TenantAccessDeniedException);
    expect(hasher.verify).toHaveBeenCalled();
    expect(sessionTokens.open).not.toHaveBeenCalled();
    expect(activity.touch).not.toHaveBeenCalled();
  });

  it('unknown email: burns a dummy verification, then the same 401 as a wrong password', async () => {
    usersSystem.findCredentialsByEmail.mockResolvedValue(null);
    await expect(
      handler.execute(new LoginCommand('nobody@example.com', 'pw')),
    ).rejects.toBeInstanceOf(InvalidCredentialsException);
    expect(hasher.verifyDummy).toHaveBeenCalledWith('pw');
    expect(selection.forLogin).not.toHaveBeenCalled();
  });

  it('wrong password → InvalidCredentialsException, no tenant picked, nothing written', async () => {
    hasher.verify.mockResolvedValue(false);
    await expect(
      handler.execute(new LoginCommand('ada@example.com', 'bad')),
    ).rejects.toBeInstanceOf(InvalidCredentialsException);
    expect(log.summary()).toEqual([['usersSystem.findCredentialsByEmail', null, null]]);
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

  it('selects the tenant as a user-scoped principal (tenantId null)', async () => {
    selection.forLogin.mockImplementation(async () => {
      expect(getPrincipal()).toEqual({
        userId: stored.id,
        tenantId: null,
        roles: [],
        staff: false,
      });
      return membership;
    });
    await handler.execute(new LoginCommand('ada@example.com', 'pw'));
    expect(selection.forLogin).toHaveBeenCalled();
  });

  it('a membership removed between the tenant choice and the touch is 403 TENANT_ACCESS_DENIED', async () => {
    // The real MembershipActivity over an in-memory store where the chosen membership is gone.
    const persistence = createInMemoryIdentityPersistence();
    const real = new MembershipActivity(
      persistence.memberships,
      mockOf<RlsElevation>({
        justified: async (_reason: string, work: () => Promise<unknown>) => work(),
      }),
    );
    handler = new LoginHandler(
      users,
      usersSystem,
      hasher,
      sessionTokens,
      selection,
      workspaces,
      bootstrap,
      real,
      events.eventBus,
    );
    await expect(
      handler.execute(new LoginCommand('ada@example.com', 'pw', undefined, TENANT)),
    ).rejects.toMatchObject({
      constructor: TenantAccessDeniedException,
      httpStatus: 403,
      code: 'TENANT_ACCESS_DENIED',
    });
    expect(events.published).toEqual([]);
  });
});

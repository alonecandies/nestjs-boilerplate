import { Global, Module } from '@nestjs/common';
import { CommandBus, CqrsModule, type ICommand } from '@nestjs/cqrs';
import { AuthModule, RbacModule } from '@platform/auth';
import {
  createPrincipal,
  generateId,
  type Principal,
  runWithPrincipal,
  sha256Hex,
} from '@platform/common';
import { redisConfig } from '@platform/config';
import {
  type DrizzleTransactionalAdapter,
  RlsElevation,
  SystemDatabase,
  TransactionHost,
} from '@platform/database';
import { MailService } from '@platform/mailer';
import { DistributedLockService, type LockBackend, RedisKeyService } from '@platform/redis';
import { KafkaProducer } from '@platform/transport';
import { FakeKafkaProducer } from '@platform/transport/testing';
import type { Sql } from 'postgres';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from 'vitest';
import { AcceptInvitationCommand } from '../src/application/commands/accept-invitation/accept-invitation.command.js';
import { CreateInvitationCommand } from '../src/application/commands/create-invitation/create-invitation.command.js';
import { CreateTenantCommand } from '../src/application/commands/create-tenant/create-tenant.command.js';
import { LoginCommand } from '../src/application/commands/login/login.command.js';
import { RefreshSessionCommand } from '../src/application/commands/refresh-session/refresh-session.command.js';
import { RegisterUserCommand } from '../src/application/commands/register-user/register-user.command.js';
import { RenameTenantCommand } from '../src/application/commands/rename-tenant/rename-tenant.command.js';
import { StaffSwitchInCommand } from '../src/application/commands/staff-switch-in/staff-switch-in.command.js';
import { SwitchTenantCommand } from '../src/application/commands/switch-tenant/switch-tenant.command.js';
import { UpdateMemberRolesCommand } from '../src/application/commands/update-member-roles/update-member-roles.command.js';
import { AuditEventsRepository } from '../src/application/persistence/audit-events.repository.js';
import { InvitationsRepository } from '../src/application/persistence/invitations.repository.js';
import { MembershipsRepository } from '../src/application/persistence/memberships.repository.js';
import { SessionsRepository } from '../src/application/persistence/sessions.repository.js';
import { createPostgresStaffStore } from '../src/cli/postgres-staff-store.js';
import { runStaffGrantCli } from '../src/cli/staff-grant.js';
import { hashInvitationToken } from '../src/domain/invitation-token.js';
import { IDENTITY_RBAC, IdentityPermission } from '../src/identity.permissions.js';
import { IdentityCoreModule } from '../src/identity-core.module.js';
import type { IdentitySchema } from '../src/infrastructure/persistence/identity.schema.js';
import { PurgeExpiredSessionsCron } from '../src/infrastructure/scheduling/purge-expired-sessions.cron.js';
import { PasswordHasher } from '../src/infrastructure/security/password-hasher.service.js';
import { FakeRedisModule } from './auth-test.module.js';
import { type IdentityDatabase, startIdentityDatabase } from './identity-database.js';

/*
 * Identity's flows on the three roles (B3 Task 12): the real IdentityCoreModule (CQRS handlers,
 * services, Drizzle repositories, the system repositories) on the real DatabaseModule over Citus
 * 14.2 with local execution off, migrated as app_owner, running as app_runtime, the system pool as
 * app_system; the real RBAC binds PrincipalPermissions. Only Redis, Kafka and mail are fakes.
 * Each flow runs as an edge would call it (the caller's principal, or none before auth); the
 * assertions read through the superuser. A spy on SystemDatabase.run pins, per flow, the system
 * methods of the plan's flow table.
 * Opt-in (needs Docker): INTEGRATION=1 bunx vitest run --project identity:int identity-flows
 */

const id = (suffix: string): string => `0197e000-0000-7000-8000-${suffix.padStart(12, '0')}`;
const TENANT_A = id('a0');
const TENANT_B = id('b0');
/** a1 owner of A, a2 member of A, a3 admin of A, b1 owner of B, c1 member of A and B. */
const A1 = id('1a1');
const A2 = id('1a2');
const A3 = id('1a3');
const B1 = id('1b1');
const C1 = id('1c1');
/** l1 logs in (member of A); w1 has no membership; s1 is platform staff; i1 accepts invitations. */
const L1 = id('1d1');
const W1 = id('1e1');
const S1 = id('1f1');
const I1 = id('1aa');
const INVITATION_B = id('2b0');
const PASSWORD = 'correct horse battery';
const ACCESS = (): { jti: string; exp: number } => ({
  jti: generateId(),
  exp: Math.floor(Date.now() / 1_000) + 900,
});

const as = (userId: string, tenantId: string | null, roles: string[] = []): Principal =>
  createPrincipal({ userId, tenantId, roles });

/** KafkaProducerModule / AppMailerModule stand-ins; the mail fake keeps the invitation tokens. */
const kafka = new FakeKafkaProducer({ source: 'identity-int' });
const mail = { enqueue: vi.fn(async () => undefined) };

@Global()
@Module({
  providers: [
    { provide: KafkaProducer, useValue: kafka },
    { provide: MailService, useValue: mail },
  ],
  exports: [KafkaProducer, MailService],
})
class FakeEdgesModule {}

describe.skipIf(process.env['INTEGRATION'] !== '1')(
  'identity flows run as a principal (Citus, local execution off)',
  () => {
    let database: IdentityDatabase | undefined;
    let admin: Sql;
    let bus: CommandBus;
    let systemRuns: MockInstance<SystemDatabase['run']>;

    beforeAll(async () => {
      // IdentityCoreModule's outbox relay would poll on the system pool and show up in the per-flow
      // system-method pins below; register-outbox.int-spec.ts drives it on its own.
      vi.stubEnv('OUTBOX_RELAY_ENABLED', 'false');
      database = await startIdentityDatabase([], {
        testPermissions: false,
        imports: [
          FakeRedisModule,
          AuthModule.forRootAsync(),
          RbacModule.forFeature(IDENTITY_RBAC),
          CqrsModule.forRoot(),
          FakeEdgesModule,
          IdentityCoreModule,
        ],
      });
      const { app } = database;
      admin = database.adminSql;
      bus = app.get(CommandBus);
      await app.init();
      // @WithLock resolves the lock service through its holder: the real one over a fake redlock.
      new DistributedLockService(
        {
          using: async (
            _k: string[],
            _t: number,
            _s: unknown,
            routine: (s: AbortSignal) => unknown,
          ) => routine(new AbortController().signal),
        } as unknown as LockBackend,
        new RedisKeyService(redisConfig.parse({ REDIS_KEY_PREFIX: 'identity-int' })),
      ).onModuleInit();

      const hash = await app.get(PasswordHasher).hash(PASSWORD);
      await admin`insert into identity.tenants (id, slug, name)
        values (${TENANT_A}, 'tenant-a', 'Tenant A'), (${TENANT_B}, 'tenant-b', 'Tenant B')`;
      for (const [userId, name, staff] of [
        [A1, 'a1', false],
        [A2, 'a2', false],
        [A3, 'a3', false],
        [B1, 'b1', false],
        [C1, 'c1', false],
        [L1, 'l1', false],
        [W1, 'w1', false],
        [S1, 's1', true],
        [I1, 'i1', false],
      ] as const) {
        await admin`insert into identity.users (id, email, password_hash, display_name, is_platform_staff)
          values (${userId}, ${`${name}@example.com`}, ${hash}, ${name}, ${staff})`;
      }
      await admin`insert into identity.memberships (tenant_id, user_id, roles, last_active_at) values
        (${TENANT_A}, ${A1}, '{owner}', null), (${TENANT_A}, ${A2}, '{member}', null),
        (${TENANT_A}, ${A3}, '{admin}', null), (${TENANT_B}, ${B1}, '{owner}', null),
        (${TENANT_A}, ${C1}, '{member}', null), (${TENANT_B}, ${C1}, '{member}', null),
        (${TENANT_A}, ${L1}, '{member}', null)`;
      await admin`insert into identity.invitations
          (tenant_id, id, email, roles, token_hash, invited_by, expires_at) values
        (${TENANT_B}, ${INVITATION_B}, 'nobody@example.com', '{member}', ${'b'.repeat(64)}, ${B1},
         ${new Date(Date.now() + 86_400_000)})`;
      await admin`insert into identity.audit_events (tenant_id, id, actor_id, type)
        values (${TENANT_B}, ${id('4b0')}, ${B1}, 'tenant.created')`;
    }, 360_000);

    afterAll(async () => {
      vi.restoreAllMocks();
      await database?.close();
    });

    // The project restores spies before each test (restoreMocks), so the spy is per test.
    beforeEach(() => {
      systemRuns = vi.spyOn(SystemDatabase.prototype, 'run');
    });

    /** The system methods the flow called, in order. */
    const systemMethods = (): string[] => systemRuns.mock.calls.map(([method]) => method.name);

    const count = async (sql: string, ...params: unknown[]): Promise<number> => {
      const [row] = await admin.unsafe<{ n: string }[]>(sql, params as never[]);
      return Number(row?.n ?? 0);
    };

    const execute = <T>(principal: Principal | null, command: ICommand): Promise<T> =>
      principal === null
        ? bus.execute<ICommand, T>(command)
        : runWithPrincipal(principal, () => bus.execute<ICommand, T>(command));

    interface Tokens {
      accessToken: string;
      refreshToken: string;
      tenantId: string;
      tenantRoles: string[];
      user: { id: string };
    }

    describe('register', () => {
      it('creates user, personal tenant, owner membership and session in one transaction', async () => {
        const tokens = await execute<Tokens>(
          null,
          new RegisterUserCommand('Grace@Example.com', PASSWORD, 'Grace'),
        );
        expect(systemMethods()).toEqual(['users.existsByEmail']);
        const userId = tokens.user.id;
        const [user] = await admin`select id from identity.users where email = 'grace@example.com'`;
        expect(user?.['id']).toBe(userId);
        const memberships = await admin`select tenant_id, roles from identity.memberships
          where user_id = ${userId}`;
        expect(memberships).toEqual([{ tenant_id: tokens.tenantId, roles: ['owner'] }]);
        const [tenant] =
          await admin`select personal from identity.tenants where id = ${tokens.tenantId}`;
        expect(tenant?.['personal']).toBe(true);
        const sessions = await admin`select tenant_id, refresh_token_hash from identity.sessions
          where user_id = ${userId}`;
        expect(sessions).toEqual([
          { tenant_id: tokens.tenantId, refresh_token_hash: sha256Hex(tokens.refreshToken) },
        ]);
      });

      it('a failing session insert leaves no user, tenant or membership', async () => {
        const sessions = database?.app.get(SessionsRepository) as SessionsRepository;
        const failure = vi.spyOn(sessions, 'create').mockRejectedValueOnce(new Error('boom'));
        await expect(
          execute(null, new RegisterUserCommand('hopper@example.com', PASSWORD, 'Hopper')),
        ).rejects.toThrow('boom');
        failure.mockRestore();
        expect(
          await count(
            `select count(*) n from identity.users where email = $1`,
            'hopper@example.com',
          ),
        ).toBe(0);
        expect(
          await count(
            `select count(*) n from identity.tenants where name = $1`,
            "Hopper's workspace",
          ),
        ).toBe(0);
      });
    });

    describe('login', () => {
      it('sets last_active_at and opens the session in the chosen tenant', async () => {
        const tokens = await execute<Tokens>(null, new LoginCommand('l1@example.com', PASSWORD));
        expect(systemMethods()).toEqual(['users.findCredentialsByEmail']);
        expect(tokens).toMatchObject({ tenantId: TENANT_A, tenantRoles: ['member'] });
        const [membership] = await admin`select last_active_at from identity.memberships
          where tenant_id = ${TENANT_A} and user_id = ${L1}`;
        expect(membership?.['last_active_at']).toBeInstanceOf(Date);
        expect(
          await count(
            `select count(*) n from identity.sessions where user_id = $1 and tenant_id = $2`,
            L1,
            TENANT_A,
          ),
        ).toBe(1);
      });

      it('a wrong password writes nothing', async () => {
        const before = await count(`select count(*) n from identity.sessions`);
        await expect(
          execute(null, new LoginCommand('a2@example.com', 'wrong')),
        ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
        expect(await count(`select count(*) n from identity.sessions`)).toBe(before);
        const [membership] = await admin`select last_active_at from identity.memberships
          where tenant_id = ${TENANT_A} and user_id = ${A2}`;
        expect(membership?.['last_active_at']).toBeNull();
      });

      it('a user without a membership gets a personal workspace', async () => {
        const tokens = await execute<Tokens>(null, new LoginCommand('w1@example.com', PASSWORD));
        expect(systemMethods()).toEqual(['users.findCredentialsByEmail']);
        expect(tokens.tenantRoles).toEqual(['owner']);
        const [tenant] =
          await admin`select personal, name from identity.tenants where id = ${tokens.tenantId}`;
        expect(tenant).toEqual({ personal: true, name: "w1's workspace" });
        expect(
          await count(
            `select count(*) n from identity.memberships where user_id = $1 and tenant_id = $2`,
            W1,
            tokens.tenantId,
          ),
        ).toBe(1);
        expect(
          await count(
            `select count(*) n from identity.sessions where user_id = $1 and tenant_id = $2`,
            W1,
            tokens.tenantId,
          ),
        ).toBe(1);
      });
    });

    describe('refresh', () => {
      it("rotates within the session's tenant; a replayed token revokes that user's sessions only", async () => {
        const first = await execute<Tokens>(
          null,
          new LoginCommand('c1@example.com', PASSWORD, undefined, TENANT_B),
        );
        const other = await execute<Tokens>(null, new LoginCommand('a1@example.com', PASSWORD));
        systemRuns.mockClear();

        const rotated = await execute<Tokens>(null, new RefreshSessionCommand(first.refreshToken));
        expect(systemMethods()).toEqual([]);
        expect(rotated).toMatchObject({ tenantId: TENANT_B, tenantRoles: ['member'] });
        const [successor] = await admin`select id, tenant_id, revoked_at from identity.sessions
          where refresh_token_hash = ${sha256Hex(rotated.refreshToken)}`;
        expect(successor).toMatchObject({ tenant_id: TENANT_B, revoked_at: null });
        const [old] = await admin`select revoked_at, replaced_by_id from identity.sessions
          where refresh_token_hash = ${sha256Hex(first.refreshToken)}`;
        expect(old?.['revoked_at']).toBeInstanceOf(Date);
        expect(old?.['replaced_by_id']).toBe(successor?.['id']);

        await expect(
          execute(null, new RefreshSessionCommand(first.refreshToken)),
        ).rejects.toMatchObject({ code: 'REFRESH_TOKEN_REUSED' });
        expect(
          await count(
            `select count(*) n from identity.sessions where user_id = $1 and revoked_at is null`,
            C1,
          ),
        ).toBe(0);
        const [kept] = await admin`select revoked_at from identity.sessions
          where refresh_token_hash = ${sha256Hex(other.refreshToken)}`;
        expect(kept?.['revoked_at']).toBeNull();
      });
    });

    describe('switch tenant', () => {
      it('without a membership is denied and writes nothing; with one it opens a session there', async () => {
        const login = await execute<Tokens>(null, new LoginCommand('a2@example.com', PASSWORD));
        const caller = as(A2, TENANT_A, ['member']);
        systemRuns.mockClear();
        const sessionsBefore = await count(
          `select count(*) n from identity.sessions where user_id = $1`,
          A2,
        );

        await expect(
          execute(caller, new SwitchTenantCommand(A2, TENANT_B, login.refreshToken, ACCESS())),
        ).rejects.toMatchObject({ code: 'TENANT_ACCESS_DENIED' });
        expect(await count(`select count(*) n from identity.sessions where user_id = $1`, A2)).toBe(
          sessionsBefore,
        );
        expect(
          await count(
            `select count(*) n from identity.sessions where user_id = $1 and revoked_at is not null`,
            A2,
          ),
        ).toBe(0);

        const c1Login = await execute<Tokens>(
          null,
          new LoginCommand('c1@example.com', PASSWORD, undefined, TENANT_A),
        );
        systemRuns.mockClear();
        const switched = await execute<Tokens>(
          as(C1, TENANT_A, ['member']),
          new SwitchTenantCommand(C1, TENANT_B, c1Login.refreshToken, ACCESS()),
        );
        expect(systemMethods()).toEqual([]);
        expect(switched).toMatchObject({ tenantId: TENANT_B, tenantRoles: ['member'] });
        const [session] = await admin`select tenant_id from identity.sessions
          where refresh_token_hash = ${sha256Hex(switched.refreshToken)}`;
        expect(session?.['tenant_id']).toBe(TENANT_B);
        const [membership] = await admin`select last_active_at from identity.memberships
          where tenant_id = ${TENANT_B} and user_id = ${C1}`;
        expect(membership?.['last_active_at']).toBeInstanceOf(Date);
      });
    });

    describe('create tenant', () => {
      it('creates the tenant and its owner membership as the new tenant', async () => {
        const created = await execute<{ tenant: { id: string }; roles: string[] }>(
          as(A2, TENANT_A, ['member']),
          new CreateTenantCommand(A2, 'New Co'),
        );
        expect(systemMethods()).toEqual([]);
        expect(created).toMatchObject({ roles: ['owner'], tenant: { name: 'New Co' } });
        expect(
          await count(
            `select count(*) n from identity.memberships where tenant_id = $1 and user_id = $2 and roles = '{owner}'`,
            created.tenant.id,
            A2,
          ),
        ).toBe(1);
      });
    });

    describe('invitations', () => {
      let token = '';

      it('an admin invites; the mail carries the token (members:manage, elevated in A only)', async () => {
        const invitation = await execute<{ id: string }>(
          as(A3, TENANT_A, ['admin']),
          new CreateInvitationCommand(TENANT_A, A3, 'i1@example.com', ['member']),
        );
        expect(systemMethods()).toEqual([]);
        const [job] = mail.enqueue.mock.calls.at(-1) as unknown as [{ context: { token: string } }];
        token = job.context.token;
        expect(
          await count(
            `select count(*) n from identity.invitations where id = $1 and tenant_id = $2`,
            invitation.id,
            TENANT_A,
          ),
        ).toBe(1);
      });

      it('accept as a member invitee creates exactly that membership and marks the invitation', async () => {
        const accepted = await execute<{ tenant: { id: string }; roles: string[] }>(
          as(I1, null),
          new AcceptInvitationCommand(I1, token),
        );
        expect(systemMethods()).toEqual(['invitations.findByTokenHash']);
        expect(accepted).toMatchObject({ tenant: { id: TENANT_A }, roles: ['member'] });
        const memberships =
          await admin`select tenant_id, roles from identity.memberships where user_id = ${I1}`;
        expect(memberships).toEqual([{ tenant_id: TENANT_A, roles: ['member'] }]);
        const [invitation] = await admin`select accepted_at from identity.invitations
          where token_hash = ${hashInvitationToken(token)}`;
        expect(invitation?.['accepted_at']).toBeInstanceOf(Date);
        expect(
          await count(
            `select count(*) n from identity.audit_events where tenant_id = $1 and type = 'invitation.accepted' and actor_id = $2`,
            TENANT_A,
            I1,
          ),
        ).toBe(1);
      });

      it('a second accept and a different email are rejected', async () => {
        await expect(
          execute(as(I1, null), new AcceptInvitationCommand(I1, token)),
        ).rejects.toMatchObject({ code: 'INVITATION_INVALID' });

        await execute(
          as(A3, TENANT_A, ['admin']),
          new CreateInvitationCommand(TENANT_A, A3, 'someone-else@example.com', ['member']),
        );
        const [job] = mail.enqueue.mock.calls.at(-1) as unknown as [{ context: { token: string } }];
        await expect(
          execute(as(W1, null), new AcceptInvitationCommand(W1, job.context.token)),
        ).rejects.toMatchObject({ code: 'INVITATION_EMAIL_MISMATCH' });
        expect(
          await count(
            `select count(*) n from identity.memberships where tenant_id = $1 and user_id = $2`,
            TENANT_A,
            W1,
          ),
        ).toBe(0);
      });
    });

    describe('members, invitations, audit (elevate(permission) first)', () => {
      const txHost = (): TransactionHost<DrizzleTransactionalAdapter<IdentitySchema>> =>
        database?.app.get(TransactionHost) as TransactionHost<
          DrizzleTransactionalAdapter<IdentitySchema>
        >;
      /** What a permission-gated read does: one unit of work, elevate(permission) first. */
      const gated = <T>(principal: Principal, read: () => Promise<T>): Promise<T> =>
        runWithPrincipal(principal, () =>
          txHost().withTransaction(async () => {
            await database?.app.get(RlsElevation).elevate(IdentityPermission.MembersManage);
            return read();
          }),
        );

      it('a member without members:manage cannot list invitations, change roles or read the audit log', async () => {
        const member = as(A2, TENANT_A, ['member']);
        const invitations = database?.app.get(InvitationsRepository) as InvitationsRepository;
        const audit = database?.app.get(AuditEventsRepository) as AuditEventsRepository;
        await expect(
          gated(member, () => invitations.listPending(TENANT_A, new Date())),
        ).rejects.toMatchObject({
          code: 'ELEVATION_DENIED',
        });
        await expect(
          execute(member, new UpdateMemberRolesCommand(TENANT_A, A2, C1, ['admin'])),
        ).rejects.toMatchObject({ code: 'ELEVATION_DENIED' });
        await expect(
          gated(member, () => audit.listForTenant(TENANT_A, { limit: 50 })),
        ).rejects.toMatchObject({
          code: 'ELEVATION_DENIED',
        });
        const [c1] =
          await admin`select roles from identity.memberships where tenant_id = ${TENANT_A} and user_id = ${C1}`;
        expect(c1?.['roles']).toEqual(['member']);
      });

      it('an admin can, and never reaches tenant B', async () => {
        const adminA = as(A3, TENANT_A, ['admin']);
        const invitations = database?.app.get(InvitationsRepository) as InvitationsRepository;
        const audit = database?.app.get(AuditEventsRepository) as AuditEventsRepository;
        const memberships = database?.app.get(MembershipsRepository) as MembershipsRepository;

        const pending = await gated(adminA, () => invitations.listPending(TENANT_A, new Date()));
        expect(pending.length).toBeGreaterThan(0);
        expect(pending.every((invitation) => invitation.tenantId === TENANT_A)).toBe(true);
        await expect(
          gated(adminA, () => invitations.listPending(TENANT_B, new Date())),
        ).resolves.toEqual([]);

        const member = await execute<{ userId: string; roles: string[] }>(
          adminA,
          new UpdateMemberRolesCommand(TENANT_A, A3, C1, ['admin']),
        );
        expect(systemMethods()).toEqual(['memberships.findMember']);
        expect(member).toMatchObject({ userId: C1, roles: ['admin'] });

        const page = await gated(adminA, () => audit.listForTenant(TENANT_A, { limit: 50 }));
        expect(page.items.map((event) => event.type)).toContain('member.roles_changed');
        expect(page.items.every((event) => event.tenantId === TENANT_A)).toBe(true);
        await expect(
          gated(adminA, () => audit.listForTenant(TENANT_B, { limit: 50 })),
        ).resolves.toMatchObject({
          items: [],
        });
        await expect(
          gated(adminA, () => memberships.updateRoles(TENANT_B, C1, ['admin'])),
        ).resolves.toBe(false);
        const [c1InB] =
          await admin`select roles from identity.memberships where tenant_id = ${TENANT_B} and user_id = ${C1}`;
        expect(c1InB?.['roles']).toEqual(['member']);
      });

      it('an owner renames the tenant (tenant:manage)', async () => {
        await execute(
          as(A1, TENANT_A, ['owner']),
          new RenameTenantCommand(TENANT_A, A1, 'Tenant A2'),
        );
        const [tenant] = await admin`select name from identity.tenants where id = ${TENANT_A}`;
        expect(tenant?.['name']).toBe('Tenant A2');
        const [b] = await admin`select name from identity.tenants where id = ${TENANT_B}`;
        expect(b?.['name']).toBe('Tenant B');
      });
    });

    describe('staff switch-in', () => {
      it('writes one audit row in the target tenant; a non-staff caller is refused', async () => {
        const before = await count(
          `select count(*) n from identity.audit_events where tenant_id = $1 and type = 'staff.switch_in'`,
          TENANT_B,
        );
        const result = await execute<{ tenantId: string; auditEventId: string }>(
          as(S1, null),
          new StaffSwitchInCommand(S1, TENANT_B, 'support ticket 42'),
        );
        expect(systemMethods()).toEqual([]);
        expect(result.tenantId).toBe(TENANT_B);
        expect(
          await count(
            `select count(*) n from identity.audit_events where tenant_id = $1 and type = 'staff.switch_in'`,
            TENANT_B,
          ),
        ).toBe(before + 1);
        expect(
          await count(
            `select count(*) n from identity.audit_events where id = $1 and tenant_id = $2 and actor_id = $3`,
            result.auditEventId,
            TENANT_B,
            S1,
          ),
        ).toBe(1);

        await expect(
          execute(as(A2, TENANT_A, ['member']), new StaffSwitchInCommand(A2, TENANT_B, 'curious')),
        ).rejects.toMatchObject({ code: 'STAFF_ONLY' });
        expect(
          await count(
            `select count(*) n from identity.audit_events where tenant_id = $1 and type = 'staff.switch_in'`,
            TENANT_B,
          ),
        ).toBe(before + 1);
      });
    });

    describe('purge expired sessions (cron)', () => {
      it('deletes the expired sessions of several users in SystemContext', async () => {
        const past = new Date(Date.now() - 60_000);
        const future = new Date(Date.now() + 86_400_000);
        const expired = [id('5a1'), id('5b1'), id('5c1')];
        const live = id('5d1');
        await admin`insert into identity.sessions (id, user_id, tenant_id, refresh_token_hash, expires_at) values
          (${expired[0] ?? ''}, ${A1}, ${TENANT_A}, ${'h'.repeat(64)}, ${past}),
          (${expired[1] ?? ''}, ${B1}, ${TENANT_B}, ${'h'.repeat(64)}, ${past}),
          (${expired[2] ?? ''}, ${C1}, ${TENANT_B}, ${'h'.repeat(64)}, ${past}),
          (${live}, ${A2}, ${TENANT_A}, ${'h'.repeat(64)}, ${future})`;
        await database?.app.get(PurgeExpiredSessionsCron).run();
        expect(systemMethods()).toEqual(['sessions.deleteExpired']);
        expect(
          await count(`select count(*) n from identity.sessions where expires_at <= now()`),
        ).toBe(0);
        expect(await count(`select count(*) n from identity.sessions where id = $1`, live)).toBe(1);
      });
    });

    describe('staff:grant CLI', () => {
      it('sets the flag as app_owner on DATABASE_MIGRATION_URL, never the pools', async () => {
        const out: string[] = [];
        const code = await runStaffGrantCli(['A2@example.com'], {
          env: { DATABASE_MIGRATION_URL: database?.pg.migrationUrl },
          connect: createPostgresStaffStore,
          out: (line) => out.push(line),
          err: (line) => out.push(line),
        });
        expect(code).toBe(0);
        expect(systemMethods()).toEqual([]);
        const [user] = await admin`select is_platform_staff from identity.users where id = ${A2}`;
        expect(user?.['is_platform_staff']).toBe(true);
      });
    });
  },
);

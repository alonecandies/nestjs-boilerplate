import {
  createPrincipal,
  generateId,
  type Principal,
  runWithPrincipal,
  SystemContext,
} from '@platform/common';
import { RowCountMismatchError } from '@platform/database';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type IdentityDatabase, startIdentityDatabase } from '../../../test/identity-database.js';
import type { AuditEventsRepository } from '../../application/persistence/audit-events.repository.js';
import type { InvitationsRepository } from '../../application/persistence/invitations.repository.js';
import type { MembershipsRepository } from '../../application/persistence/memberships.repository.js';
import type { SessionsRepository } from '../../application/persistence/sessions.repository.js';
import type { TenantsRepository } from '../../application/persistence/tenants.repository.js';
import type { UsersRepository } from '../../application/persistence/users.repository.js';
import { UserAggregate } from '../../domain/user.aggregate.js';
import { DrizzleAuditEventsRepository } from './drizzle-audit-events.repository.js';
import { DrizzleInvitationsRepository } from './drizzle-invitations.repository.js';
import { DrizzleInvitationsSystemRepository } from './drizzle-invitations.system-repository.js';
import { DrizzleMembershipsRepository } from './drizzle-memberships.repository.js';
import { DrizzleMembershipsSystemRepository } from './drizzle-memberships.system-repository.js';
import { DrizzleSessionsRepository } from './drizzle-sessions.repository.js';
import { DrizzleSessionsSystemRepository } from './drizzle-sessions.system-repository.js';
import { DrizzleTenantsRepository } from './drizzle-tenants.repository.js';
import { DrizzleTransactionRunner } from './drizzle-transaction.runner.js';
import { DrizzleUsersRepository } from './drizzle-users.repository.js';
import { DrizzleUsersSystemRepository } from './drizzle-users.system-repository.js';

/*
 * Identity's repositories on the three roles (B3 Task 11): the real DatabaseModule on Citus 14.2
 * with local execution off, migrated as app_owner, running as app_runtime, the system pool as
 * app_system; seeded through the superuser. Every public method of every runtime port is called
 * standalone as the right principal (a typed table: adding a port method without a case does not
 * compile), and once with no principal. The system repositories run on the app_system pool by
 * their named methods (identity.system-methods.ts).
 * Opt-in (needs Docker): INTEGRATION=1 bunx vitest run --project identity:int identity.repositories
 */

const id = (suffix: string): string => `0197c000-0000-7000-8000-${suffix.padStart(12, '0')}`;
const TENANT_A = id('a0');
const TENANT_B = id('b0');
/** a1 owner of A, a2 member of A, b1 owner of B, c1 member of both (B most recently active). */
const A1 = id('1a1');
const A2 = id('1a2');
const B1 = id('1b1');
const C1 = id('1c1');
/** d1 belongs to no tenant (joins A in the insert case); e1 is a member of A (leaves it). */
const D1 = id('1d1');
const E1 = id('1e1');
const INVITATION_A = id('2a0');
const INVITATION_B = id('2b0');
const TOKEN_A = 'a'.repeat(64);
const TOKEN_B = 'b'.repeat(64);
const SESSION_A1 = id('3a1');
const SESSION_A2 = id('3a2');
const SESSION_B1 = id('3b1');
const SESSION_C1 = id('3c1');
const SESSION_EXPIRED = id('3e0');
const EVENT_A = id('4a0');
const EVENT_B = id('4b0');
const HASH = 'h'.repeat(64);

const as = (userId: string, tenantId: string | null, roles: string[] = []): Principal =>
  createPrincipal({ userId, tenantId, roles });
const a1InA = as(A1, TENANT_A, ['owner']);
const a2InA = as(A2, TENANT_A, ['member']);
const b1InB = as(B1, TENANT_B, ['owner']);
const c1InA = as(C1, TENANT_A, ['member']);
const c1InB = as(C1, TENANT_B, ['member']);

const sorted = (values: readonly string[]): string[] => [...values].sort();

interface Ports {
  users: UsersRepository;
  sessions: SessionsRepository;
  tenants: TenantsRepository;
  memberships: MembershipsRepository;
  invitations: InvitationsRepository;
  auditEvents: AuditEventsRepository;
}

/** One standalone call: `elevated` runs it in a unit of work that elevates first. */
interface Case {
  readonly principal: Principal;
  readonly elevated?: boolean;
  readonly call: () => Promise<unknown>;
  readonly expected: (result: unknown) => void | Promise<void>;
}

/** Compile-time exhaustive: one case per public method of every runtime port. */
type CaseTable = { readonly [P in keyof Ports]: { readonly [M in keyof Ports[P]]-?: Case } };

describe.skipIf(process.env['INTEGRATION'] !== '1')(
  'identity repositories on the three roles (Citus, local execution off)',
  () => {
    let database: IdentityDatabase | undefined;
    let admin: Sql;
    let ports: Ports;
    let usersSystem: DrizzleUsersSystemRepository;
    let membershipsSystem: DrizzleMembershipsSystemRepository;
    let invitationsSystem: DrizzleInvitationsSystemRepository;
    let sessionsSystem: DrizzleSessionsSystemRepository;
    const now = new Date();
    const later = new Date(now.getTime() + 86_400_000);

    beforeAll(async () => {
      database = await startIdentityDatabase([
        DrizzleUsersRepository,
        DrizzleSessionsRepository,
        DrizzleTenantsRepository,
        DrizzleMembershipsRepository,
        DrizzleInvitationsRepository,
        DrizzleAuditEventsRepository,
        DrizzleTransactionRunner,
        DrizzleUsersSystemRepository,
        DrizzleMembershipsSystemRepository,
        DrizzleInvitationsSystemRepository,
        DrizzleSessionsSystemRepository,
      ]);
      const { app } = database;
      admin = database.adminSql;
      ports = {
        users: app.get(DrizzleUsersRepository),
        sessions: app.get(DrizzleSessionsRepository),
        tenants: app.get(DrizzleTenantsRepository),
        memberships: app.get(DrizzleMembershipsRepository),
        invitations: app.get(DrizzleInvitationsRepository),
        auditEvents: app.get(DrizzleAuditEventsRepository),
      };
      usersSystem = app.get(DrizzleUsersSystemRepository);
      membershipsSystem = app.get(DrizzleMembershipsSystemRepository);
      invitationsSystem = app.get(DrizzleInvitationsSystemRepository);
      sessionsSystem = app.get(DrizzleSessionsSystemRepository);

      await admin`insert into identity.tenants (id, slug, name)
        values (${TENANT_A}, 'tenant-a', 'Tenant A'), (${TENANT_B}, 'tenant-b', 'Tenant B')`;
      for (const [userId, name] of [
        [A1, 'a1'],
        [A2, 'a2'],
        [B1, 'b1'],
        [C1, 'c1'],
        [D1, 'd1'],
        [E1, 'e1'],
      ] as const) {
        await admin`insert into identity.users (id, email, password_hash, display_name)
          values (${userId}, ${`${name}@example.com`}, ${`hash-${name}`}, ${name})`;
      }
      await admin`insert into identity.memberships (tenant_id, user_id, roles, last_active_at) values
        (${TENANT_A}, ${A1}, '{owner}', null), (${TENANT_A}, ${A2}, '{member}', null),
        (${TENANT_A}, ${C1}, '{member}', ${new Date('2026-01-01T00:00:00Z')}),
        (${TENANT_A}, ${E1}, '{member}', null), (${TENANT_B}, ${B1}, '{owner}', null),
        (${TENANT_B}, ${C1}, '{member}', ${new Date('2026-02-01T00:00:00Z')})`;
      await admin`insert into identity.invitations
          (tenant_id, id, email, roles, token_hash, invited_by, expires_at) values
        (${TENANT_A}, ${INVITATION_A}, 'new-a@example.com', '{member}', ${TOKEN_A}, ${A1}, ${later}),
        (${TENANT_B}, ${INVITATION_B}, 'new-b@example.com', '{member}', ${TOKEN_B}, ${B1}, ${later})`;
      await admin`insert into identity.sessions
          (id, user_id, tenant_id, refresh_token_hash, expires_at) values
        (${SESSION_A1}, ${A1}, ${TENANT_A}, ${HASH}, ${later}),
        (${SESSION_A2}, ${A2}, ${TENANT_A}, ${HASH}, ${later}),
        (${SESSION_B1}, ${B1}, ${TENANT_B}, ${HASH}, ${later}),
        (${SESSION_C1}, ${C1}, ${TENANT_B}, ${HASH}, ${later}),
        (${SESSION_EXPIRED}, ${B1}, ${TENANT_B}, ${HASH}, ${new Date(now.getTime() - 1_000)})`;
      await admin`insert into identity.audit_events (tenant_id, id, actor_id, type) values
        (${TENANT_A}, ${EVENT_A}, ${A1}, 'tenant.created'),
        (${TENANT_B}, ${EVENT_B}, ${B1}, 'tenant.created')`;
    }, 360_000);

    afterAll(async () => {
      await database?.close();
    });

    const run = (c: Case): Promise<unknown> =>
      c.elevated === true
        ? (database as IdentityDatabase).elevated(c.principal, c.call)
        : runWithPrincipal(c.principal, c.call);

    /** Only the rows the superuser sees: the "it really happened" check. */
    const exists = async (table: string, where: string, value: string): Promise<boolean> =>
      (await admin.unsafe(`select 1 from identity.${table} where ${where} = $1`, [value])).length >
      0;

    // System reads first: the exhaustive table below changes tenant A's memberships.
    describe('system repositories (app_system, by named system method)', () => {
      it('pre-auth: the credential lookups work with no principal and no SystemContext', async () => {
        await expect(usersSystem.findCredentialsByEmail('a1@example.com')).resolves.toMatchObject({
          id: A1,
          passwordHash: 'hash-a1',
        });
        await expect(usersSystem.findCredentialsByEmail('nobody@example.com')).resolves.toBeNull();
        await expect(usersSystem.existsByEmail('b1@example.com')).resolves.toBe(true);
        await expect(usersSystem.existsByEmail('nobody@example.com')).resolves.toBe(false);
      });

      it('pre-auth: findByTokenHash finds a token of a tenant the caller does not belong to (multi-shard)', async () => {
        await expect(
          runWithPrincipal(a2InA, () => invitationsSystem.findByTokenHash(TOKEN_B)),
        ).resolves.toMatchObject({ tenantId: TENANT_B, id: INVITATION_B, invitedBy: B1 });
        await expect(invitationsSystem.findByTokenHash(TOKEN_A)).resolves.toMatchObject({
          tenantId: TENANT_A,
          id: INVITATION_A,
        });
        await expect(invitationsSystem.findByTokenHash('0'.repeat(64))).resolves.toBeNull();
      });

      it('system: deleteExpired rejects outside SystemContext, also under a principal', async () => {
        await expect(sessionsSystem.deleteExpired(now)).rejects.toMatchObject({
          code: 'SYSTEM_CONTEXT_REQUIRED',
        });
        await expect(
          runWithPrincipal(b1InB, () => sessionsSystem.deleteExpired(now)),
        ).rejects.toMatchObject({ code: 'SYSTEM_CONTEXT_REQUIRED' });
        expect(await exists('sessions', 'id', SESSION_EXPIRED)).toBe(true);
      });

      it('system: deleteExpired in SystemContext deletes exactly the expired sessions', async () => {
        await expect(
          SystemContext.run('identity.purge-expired-sessions', () =>
            sessionsSystem.deleteExpired(now),
          ),
        ).resolves.toBe(1);
        expect(await exists('sessions', 'id', SESSION_EXPIRED)).toBe(false);
        expect(await exists('sessions', 'id', SESSION_B1)).toBe(true);
      });

      it('system: deleteExpired drains a backlog spread over many 15-minute slices in one run', async () => {
        // 12 expired sessions 40 minutes apart (one slice each, the gaps skipped), one expiring
        // exactly now (due: `<=`), one an hour ahead (kept); users on different shards.
        const backlog = Array.from({ length: 12 }, (_, i) => ({
          id: generateId(),
          userId: [A1, A2, B1, C1][i % 4] ?? A1,
          tenantId: i % 4 < 2 ? TENANT_A : TENANT_B,
          expiresAt: new Date(now.getTime() - (i + 1) * 40 * 60_000),
        }));
        const atCutoff = generateId();
        const ahead = generateId();
        for (const row of [
          ...backlog,
          { id: atCutoff, userId: A1, tenantId: TENANT_A, expiresAt: now },
          {
            id: ahead,
            userId: B1,
            tenantId: TENANT_B,
            expiresAt: new Date(now.getTime() + 3_600_000),
          },
        ]) {
          await admin`insert into identity.sessions
              (id, user_id, tenant_id, refresh_token_hash, expires_at)
            values (${row.id}, ${row.userId}, ${row.tenantId}, ${HASH}, ${row.expiresAt})`;
        }

        await expect(
          SystemContext.run('identity.purge-expired-sessions', () =>
            sessionsSystem.deleteExpired(now),
          ),
        ).resolves.toBe(13);
        const due = await admin<{ n: number }[]>`
          select count(*)::int as n from identity.sessions where expires_at <= ${now}`;
        expect(due).toEqual([{ n: 0 }]);
        expect(await exists('sessions', 'id', atCutoff)).toBe(false);
        expect(await exists('sessions', 'id', ahead)).toBe(true);
        expect(await exists('sessions', 'id', SESSION_B1)).toBe(true);
      });

      it("system (ruling): the member directory returns the asserted tenant's members only", async () => {
        const directory = (work: () => Promise<unknown>) =>
          SystemContext.run('identity.member-directory', work);
        const pageA = (await directory(() =>
          usersSystem.listInTenant({ tenantId: TENANT_A, limit: 50 }),
        )) as { items: { id: string }[]; nextCursor: string | null };
        expect(sorted(pageA.items.map((user) => user.id))).toEqual(sorted([A1, A2, C1, E1]));
        expect(pageA.nextCursor).toBeNull();
        expect(pageA.items[0]).not.toHaveProperty('passwordHash');
        const searchB = (await directory(() =>
          usersSystem.listInTenant({ tenantId: TENANT_B, limit: 50, search: 'C1' }),
        )) as { items: { id: string }[] };
        expect(searchB.items.map((user) => user.id)).toEqual([C1]);
        await expect(
          directory(() => usersSystem.findByIdInTenant(A1, TENANT_A)),
        ).resolves.toMatchObject({ id: A1, email: 'a1@example.com' });
        await expect(
          directory(() => usersSystem.findByIdInTenant(B1, TENANT_A)),
        ).resolves.toBeNull();

        const members = (await directory(() =>
          membershipsSystem.listMembers(TENANT_B, { limit: 50 }),
        )) as { items: { userId: string; email: string; roles: string[] }[] };
        expect(sorted(members.items.map((member) => member.userId))).toEqual(sorted([B1, C1]));
        expect(members.items.find((member) => member.userId === B1)).toMatchObject({
          email: 'b1@example.com',
          roles: ['owner'],
        });
        await expect(
          directory(() => membershipsSystem.findMember(TENANT_B, C1)),
        ).resolves.toMatchObject({ userId: C1, displayName: 'c1', roles: ['member'] });
        await expect(
          directory(() => membershipsSystem.findMember(TENANT_B, A1)),
        ).resolves.toBeNull();
      });

      it('system (ruling): listForUser returns every tenant of the asserted user, most recent first', async () => {
        const mine = (await SystemContext.run('identity.my-tenants', () =>
          membershipsSystem.listForUser(C1),
        )) as { tenantId: string; tenant: { id: string; slug: string } }[];
        expect(mine.map((membership) => membership.tenantId)).toEqual([TENANT_B, TENANT_A]);
        expect(mine[0]?.tenant).toMatchObject({ id: TENANT_B, slug: 'tenant-b' });
        await expect(
          SystemContext.run('identity.my-tenants', () => membershipsSystem.listForUser(D1)),
        ).resolves.toEqual([]);
      });

      it('system (ruling): the directory reads reject outside SystemContext', async () => {
        const outside: (() => Promise<unknown>)[] = [
          () => usersSystem.listInTenant({ tenantId: TENANT_A, limit: 1 }),
          () => usersSystem.findByIdInTenant(A1, TENANT_A),
          () => membershipsSystem.listMembers(TENANT_A, { limit: 1 }),
          () => membershipsSystem.findMember(TENANT_A, A1),
          () => membershipsSystem.listForUser(C1),
        ];
        for (const read of outside) {
          await expect(runWithPrincipal(a1InA, read)).rejects.toMatchObject({
            code: 'SYSTEM_CONTEXT_REQUIRED',
          });
        }
      });
    });

    describe('runtime ports (app_runtime, through inUnitOfWork)', () => {
      const register = (userId: string) =>
        UserAggregate.register({
          id: userId,
          email: `${userId}@example.com`,
          displayName: 'Registered',
          passwordHash: 'hash-new',
          now,
        });
      const NEW_USER = id('5a0');
      const NEW_TENANT = id('5b0');

      const cases = (): CaseTable => ({
        users: {
          findById: {
            principal: a2InA,
            call: () => ports.users.findById(A2),
            expected: (user) => expect(user).toMatchObject({ id: A2, email: 'a2@example.com' }),
          },
          findByIds: {
            // Row-local: a co-member is not readable through the runtime pool (the ruling).
            principal: a2InA,
            call: () => ports.users.findByIds([A2, A1, C1, id('dead')]),
            expected: (users) => expect((users as { id: string }[]).map((u) => u.id)).toEqual([A2]),
          },
          isPlatformStaff: {
            principal: a2InA,
            call: () => ports.users.isPlatformStaff(A2),
            expected: (staff) => expect(staff).toBe(false),
          },
          insert: {
            principal: as(NEW_USER, null),
            call: () => ports.users.insert(register(NEW_USER)),
            expected: async () => expect(await exists('users', 'id', NEW_USER)).toBe(true),
          },
          updatePasswordHash: {
            principal: a2InA,
            call: () => ports.users.updatePasswordHash(A2, 'hash-a2-rehashed', now),
            expected: async () => {
              const [row] = await admin`select password_hash from identity.users where id = ${A2}`;
              expect(row?.['password_hash']).toBe('hash-a2-rehashed');
            },
          },
        },
        sessions: {
          create: {
            principal: a2InA,
            call: () =>
              ports.sessions.create({
                id: id('6a0'),
                userId: A2,
                tenantId: TENANT_A,
                refreshTokenHash: HASH,
                userAgent: null,
                ip: null,
                expiresAt: later,
              }),
            expected: async () => expect(await exists('sessions', 'id', id('6a0'))).toBe(true),
          },
          findById: {
            principal: a2InA,
            call: () => ports.sessions.findById(A2, SESSION_A2),
            expected: (session) =>
              expect(session).toMatchObject({ id: SESSION_A2, userId: A2, tenantId: TENANT_A }),
          },
          revokeForRotation: {
            principal: a1InA,
            call: () =>
              ports.sessions.revokeForRotation({
                id: SESSION_A1,
                userId: A1,
                refreshTokenHash: HASH,
                replacedById: id('6a1'),
                now,
              }),
            expected: (rotated) => expect(rotated).toBe(true),
          },
          revoke: {
            principal: b1InB,
            call: () => ports.sessions.revoke({ id: SESSION_B1, userId: B1, now }),
            expected: (revoked) => expect(revoked).toBe(true),
          },
          revokeAllForUser: {
            principal: c1InB,
            call: () => ports.sessions.revokeAllForUser(C1, now),
            expected: (count) => expect(count).toBe(1),
          },
        },
        tenants: {
          insert: {
            principal: as(A1, NEW_TENANT, ['owner']),
            call: () =>
              ports.tenants.insert({
                id: NEW_TENANT,
                slug: 'new-tenant',
                name: 'New',
                personal: true,
              }),
            expected: async () => expect(await exists('tenants', 'id', NEW_TENANT)).toBe(true),
          },
          findById: {
            principal: a2InA,
            call: () => ports.tenants.findById(TENANT_A),
            expected: (tenant) => expect(tenant).toMatchObject({ id: TENANT_A, slug: 'tenant-a' }),
          },
          findByIds: {
            // Row-local: only the session tenant (other tenants go through the system read).
            principal: c1InB,
            call: () => ports.tenants.findByIds([TENANT_A, TENANT_B]),
            expected: (tenants) =>
              expect((tenants as { id: string }[]).map((t) => t.id)).toEqual([TENANT_B]),
          },
          existsBySlug: {
            principal: a2InA,
            call: () => ports.tenants.existsBySlug('tenant-a'),
            expected: (exists) => expect(exists).toBe(true),
          },
          rename: {
            principal: a1InA,
            elevated: true,
            call: () => ports.tenants.rename(TENANT_A, 'Tenant A renamed'),
            expected: (renamed) => expect(renamed).toBe(true),
          },
        },
        memberships: {
          insert: {
            principal: a1InA,
            elevated: true,
            call: () =>
              ports.memberships.insert({
                tenantId: TENANT_A,
                userId: D1,
                roles: ['member'],
                lastActiveAt: null,
              }),
            expected: async () =>
              expect(
                (
                  await admin`select 1 from identity.memberships
                  where tenant_id = ${TENANT_A} and user_id = ${D1}`
                ).length,
              ).toBe(1),
          },
          find: {
            // Same tenant: memberships are readable by tenant (`tenant_id = app.tenant_id()`).
            principal: a2InA,
            call: () => ports.memberships.find(TENANT_A, A1),
            expected: (membership) =>
              expect(membership).toMatchObject({
                tenantId: TENANT_A,
                userId: A1,
                roles: ['owner'],
              }),
          },
          findMostRecentForUser: {
            principal: as(C1, null),
            call: () => ports.memberships.findMostRecentForUser(C1),
            expected: (membership) => expect(membership).toMatchObject({ tenantId: TENANT_B }),
          },
          listForUser: {
            // Row-local tenants: only the session tenant's row joins (all of them: the system read).
            principal: c1InB,
            call: () => ports.memberships.listForUser(C1),
            expected: (memberships) =>
              expect(
                (memberships as { tenantId: string; tenant: { id: string } }[]).map((m) => [
                  m.tenantId,
                  m.tenant.id,
                ]),
              ).toEqual([[TENANT_B, TENANT_B]]),
          },
          touch: {
            principal: c1InA,
            elevated: true,
            call: () => ports.memberships.touch(TENANT_A, C1, now),
            expected: async () => {
              const [row] = await admin`select last_active_at from identity.memberships
                where tenant_id = ${TENANT_A} and user_id = ${C1}`;
              expect(row?.['last_active_at']).toEqual(now);
            },
          },
          updateRoles: {
            principal: a1InA,
            elevated: true,
            call: () => ports.memberships.updateRoles(TENANT_A, A2, ['member']),
            expected: (updated) => expect(updated).toBe(true),
          },
          delete: {
            // A member leaves without elevation (`user_id = app.user_id()`).
            principal: as(E1, TENANT_A, ['member']),
            call: () => ports.memberships.delete(TENANT_A, E1),
            expected: (deleted) => expect(deleted).toBe(true),
          },
          countOwnersLocked: {
            principal: a2InA,
            call: () => ports.memberships.countOwnersLocked(TENANT_A),
            expected: (owners) => expect(owners).toBe(1),
          },
        },
        invitations: {
          insert: {
            principal: a1InA,
            elevated: true,
            call: () =>
              ports.invitations.insert({
                tenantId: TENANT_A,
                id: id('7a0'),
                email: 'later@example.com',
                roles: ['member'],
                tokenHash: 'c'.repeat(64),
                invitedBy: A1,
                expiresAt: new Date(now.getTime() - 1_000), // expired: not in listPending
              }),
            expected: async () => expect(await exists('invitations', 'id', id('7a0'))).toBe(true),
          },
          listPending: {
            principal: a1InA,
            elevated: true,
            call: () => ports.invitations.listPending(TENANT_A, now),
            expected: (pending) =>
              expect((pending as { id: string }[]).map((i) => i.id)).toEqual([INVITATION_A]),
          },
          markAccepted: {
            principal: b1InB,
            elevated: true,
            call: () => ports.invitations.markAccepted(TENANT_B, INVITATION_B, now),
            expected: (accepted) => expect(accepted).toBe(true),
          },
        },
        auditEvents: {
          append: {
            principal: a2InA,
            call: () =>
              ports.auditEvents.append({
                tenantId: TENANT_A,
                id: id('8a0'),
                actorId: A2,
                type: 'member.left',
                data: {},
                createdAt: now,
              }),
            expected: async () => expect(await exists('audit_events', 'id', id('8a0'))).toBe(true),
          },
          listForTenant: {
            principal: b1InB,
            elevated: true,
            call: () => ports.auditEvents.listForTenant(TENANT_B, { limit: 10 }),
            expected: (page) =>
              expect((page as { items: { id: string }[] }).items.map((e) => e.id)).toEqual([
                EVENT_B,
              ]),
          },
        },
      });

      const table = (): [string, Case][] =>
        Object.entries(cases()).flatMap(([port, methods]) =>
          Object.entries(methods as Record<string, Case>).map(
            ([method, c]) => [`${port}.${method}`, c] as [string, Case],
          ),
        );

      it('the case table covers the 28 runtime methods', () => {
        expect(table()).toHaveLength(28);
      });

      it('with no principal every runtime method rejects (RLS_NO_PRINCIPAL) and changes nothing', async () => {
        const before = await admin`select (select count(*) from identity.users)::int as users,
          (select count(*) from identity.tenants)::int as tenants,
          (select count(*) from identity.memberships)::int as memberships,
          (select count(*) from identity.sessions where revoked_at is null)::int as sessions,
          (select count(*) from identity.invitations where accepted_at is null)::int as invitations,
          (select count(*) from identity.audit_events)::int as events`;
        for (const [name, c] of table()) {
          await expect(c.call(), name).rejects.toMatchObject({
            name: 'RlsContextError',
            code: 'RLS_NO_PRINCIPAL',
          });
        }
        const after = await admin`select (select count(*) from identity.users)::int as users,
          (select count(*) from identity.tenants)::int as tenants,
          (select count(*) from identity.memberships)::int as memberships,
          (select count(*) from identity.sessions where revoked_at is null)::int as sessions,
          (select count(*) from identity.invitations where accepted_at is null)::int as invitations,
          (select count(*) from identity.audit_events)::int as events`;
        expect(after).toEqual(before);
      });

      it('each runtime method, standalone as the right principal, returns the expected rows', async () => {
        for (const [name, c] of table()) {
          let result: unknown;
          try {
            result = await run(c);
          } catch (error) {
            throw new Error(`${name} failed: ${(error as Error).message}`, { cause: error });
          }
          await c.expected(result);
        }
      });

      it('updatePasswordHash of another user throws RowCountMismatchError and changes nothing', async () => {
        const failure = await runWithPrincipal(a2InA, () =>
          ports.users.updatePasswordHash(A1, 'stolen', now),
        ).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(RowCountMismatchError);
        expect(failure).toMatchObject({ expected: 1, actual: 0 });
        const [row] = await admin`select password_hash from identity.users where id = ${A1}`;
        expect(row?.['password_hash']).toBe('hash-a1');
      });

      it('touch without elevation throws RowCountMismatchError and changes nothing', async () => {
        const at = new Date('2030-01-01T00:00:00Z');
        const failure = await runWithPrincipal(a2InA, () =>
          ports.memberships.touch(TENANT_A, A2, at),
        ).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(RowCountMismatchError);
        expect(failure).toMatchObject({ expected: 1, actual: 0 });
        const [row] = await admin`select last_active_at from identity.memberships
          where tenant_id = ${TENANT_A} and user_id = ${A2}`;
        expect(row?.['last_active_at']).toBeNull();
      });

      it('a standalone call is its own transaction: a repository call never sees another tenant', async () => {
        // rename with elevation in A never touches B (the policy keeps app.tenant_id).
        await expect(
          (database as IdentityDatabase).elevated(a1InA, () =>
            ports.tenants.rename(TENANT_B, 'hijacked'),
          ),
        ).resolves.toBe(false);
        const [row] = await admin`select name from identity.tenants where id = ${TENANT_B}`;
        expect(row?.['name']).toBe('Tenant B');
      });
    });
  },
);

import {
  createPrincipal,
  generateId,
  isUuidV7,
  PLATFORM_TENANT_ID,
  runWithPrincipal,
  SystemContext,
  sha256Hex,
} from '@platform/common';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type IdentityDatabase, startIdentityDatabase } from '../../../test/identity-database.js';
import {
  InvalidRolesException,
  MembershipAlreadyExistsException,
  TenantSlugTakenException,
} from '../../domain/identity.errors.js';
import {
  generateInvitationToken,
  hashInvitationToken,
  INVITATION_TTL_MS,
} from '../../domain/invitation-token.js';
import { DrizzleAuditEventsRepository } from './drizzle-audit-events.repository.js';
import { DrizzleInvitationsRepository } from './drizzle-invitations.repository.js';
import { DrizzleInvitationsSystemRepository } from './drizzle-invitations.system-repository.js';
import { DrizzleMembershipsRepository } from './drizzle-memberships.repository.js';
import { DrizzleMembershipsSystemRepository } from './drizzle-memberships.system-repository.js';
import { DrizzleTenantsRepository } from './drizzle-tenants.repository.js';

/*
 * identity's tenancy repositories against Citus 14.2 (single node, local execution off) with
 * identity's real migration history, on the three roles (test/identity-database.ts): every runtime
 * call runs as a principal under the 0009 policies (writes that need elevation inside
 * `database.elevated`), the cross-tenant reads through the system repositories, seeding and
 * constraint probes through the superuser. Opt-in: INTEGRATION=1 npx vitest run --project identity:int tenancy
 * The tables are distributed by identity's 0008_distribute (SH-5); every query carries its
 * distribution column (sharding design §2.1).
 */

/**
 * The constraint the driver error (the drizzle error's `cause`) names. A Citus shard raises it as
 * `<logical>_<shard id>`; with local execution off (this harness, as on a cluster) the error is
 * relayed without `constraint_name`, so only the message names it.
 */
const constraintOf = (error: unknown): string | undefined => {
  const cause = (error as { cause?: { constraint_name?: unknown; message?: unknown } } | undefined)
    ?.cause;
  if (typeof cause?.constraint_name === 'string') return cause.constraint_name;
  return typeof cause?.message === 'string'
    ? /constraint "([^"]+)"/.exec(cause.message)?.[1]
    : undefined;
};

/** The logical constraint name, optionally with a Citus shard suffix. */
const constraintNamed = (logical: string): RegExp => new RegExp(`^${logical}(_\\d+)?$`);

describe.skipIf(process.env['INTEGRATION'] !== '1')(
  'identity tenancy repositories on Citus',
  () => {
    let database: IdentityDatabase | undefined;
    let tenants: DrizzleTenantsRepository;
    let memberships: DrizzleMembershipsRepository;
    let invitations: DrizzleInvitationsRepository;
    let auditEvents: DrizzleAuditEventsRepository;
    let invitationsSystem: DrizzleInvitationsSystemRepository;
    let membershipsSystem: DrizzleMembershipsSystemRepository;
    const run = generateId().slice(-8);
    const slug = (name: string): string => `${name}-${run}`;
    /** The acting user where only the tenant matters to the policy (it need not exist). */
    const ACTOR = generateId();

    /** `work` as `userId` in `tenantId` (a standalone unit of work per repository call). */
    const as = <T>(tenantId: string | null, work: () => Promise<T>, userId = ACTOR): Promise<T> =>
      runWithPrincipal(createPrincipal({ userId, tenantId }), work);
    /** `work` in ONE unit of work as `userId` in `tenantId`, elevated (RlsElevation.elevate). */
    const elevated = <T>(tenantId: string, work: () => Promise<T>, userId = ACTOR): Promise<T> =>
      (database as IdentityDatabase).elevated(
        createPrincipal({ userId, tenantId, roles: ['owner'] }),
        work,
      );
    const system = <T>(work: () => Promise<T>): Promise<T> =>
      SystemContext.run('identity.tenancy-int', work);
    const admin = () => (database as IdentityDatabase).admin;

    beforeAll(async () => {
      database = await startIdentityDatabase([
        DrizzleTenantsRepository,
        DrizzleMembershipsRepository,
        DrizzleInvitationsRepository,
        DrizzleAuditEventsRepository,
        DrizzleInvitationsSystemRepository,
        DrizzleMembershipsSystemRepository,
      ]);
      tenants = database.app.get(DrizzleTenantsRepository);
      memberships = database.app.get(DrizzleMembershipsRepository);
      invitations = database.app.get(DrizzleInvitationsRepository);
      auditEvents = database.app.get(DrizzleAuditEventsRepository);
      invitationsSystem = database.app.get(DrizzleInvitationsSystemRepository);
      membershipsSystem = database.app.get(DrizzleMembershipsSystemRepository);
    }, 360_000);

    afterAll(async () => {
      await database?.close();
    });

    /** Created as a member of the new tenant (`tenants_insert`: id = app.tenant_id()). */
    const newTenant = async (name: string, personal = false): Promise<string> => {
      const id = generateId();
      await as(id, () =>
        tenants.insert({ id, slug: slug(name), name: `${name} workspace`, personal }),
      );
      return id;
    };

    describe('tenants', () => {
      it('insert → findById / findByIds / existsBySlug / rename, within the session tenant', async () => {
        const id = await newTenant('acme', true);
        await expect(as(id, () => tenants.findById(id))).resolves.toMatchObject({
          id,
          slug: slug('acme'),
          name: 'acme workspace',
          personal: true,
          createdAt: expect.any(Date),
        });
        const other = await newTenant('globex');
        // Row-local: each principal reads only its session tenant (all of a user's tenants: the
        // system listForUser, below).
        const found = await as(id, () => tenants.findByIds([id, other, generateId()]));
        expect(found.map((tenant) => tenant.id)).toEqual([id]);
        const foundInOther = await as(other, () => tenants.findByIds([id, other]));
        expect(foundInOther.map((tenant) => tenant.id)).toEqual([other]);
        await expect(as(id, () => tenants.findByIds([]))).resolves.toEqual([]);
        await expect(as(id, () => tenants.existsBySlug(slug('acme')))).resolves.toBe(true);
        await expect(as(id, () => tenants.existsBySlug(slug('nope')))).resolves.toBe(false);
        // Another tenant's slug is invisible: the unique constraint decides (next test).
        await expect(as(other, () => tenants.existsBySlug(slug('acme')))).resolves.toBe(false);
        await expect(elevated(id, () => tenants.rename(id, 'Acme Inc.'))).resolves.toBe(true);
        await expect(as(id, () => tenants.findById(id))).resolves.toMatchObject({
          name: 'Acme Inc.',
        });
        await expect(elevated(id, () => tenants.rename(generateId(), 'x'))).resolves.toBe(false);
        // Elevation never crosses tenants.
        await expect(elevated(id, () => tenants.rename(other, 'x'))).resolves.toBe(false);
      });

      it('maps tenants_slug_unique to TenantSlugTakenException (a slug the caller cannot see)', async () => {
        await newTenant('dupe');
        const id = generateId();
        await expect(
          as(id, () => tenants.insert({ id, slug: slug('dupe'), name: 'x', personal: false })),
        ).rejects.toBeInstanceOf(TenantSlugTakenException);
      });

      it('refuses the platform tenant id (tenants_id_not_platform)', async () => {
        // No principal can carry the platform tenant (createPrincipal refuses it), so the
        // constraint is probed through the superuser.
        const failure: unknown = await admin()
          .execute(
            sql`insert into identity.tenants (id, slug, name) values (${PLATFORM_TENANT_ID}, ${slug('platform')}, 'Platform')`,
          )
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        expect(constraintOf(failure)).toMatch(constraintNamed('tenants_id_not_platform'));
      });

      it('defaults id (uuidv7) and personal = false for raw SQL inserts', async () => {
        const [row] = await admin().execute<{
          id: string;
          personal: boolean;
        }>(
          sql`insert into identity.tenants (slug, name) values (${slug('raw')}, 'Raw') returning id, personal`,
        );
        expect(isUuidV7(row?.id)).toBe(true);
        expect(row?.personal).toBe(false);
      });
    });

    /** A user row by raw SQL through the superuser (no dependency on the users repository). */
    const newUser = async (name: string): Promise<string> => {
      const [row] = await admin().execute<{ id: string }>(sql`
      insert into identity.users (email, password_hash, display_name)
      values (${`${name}.${run}@example.com`}, 'x', ${name}) returning id`);
      if (row === undefined) throw new Error('user insert returned nothing');
      return row.id;
    };

    describe('memberships', () => {
      it('insert (elevated) → find, roles normalized; empty roles refused before any SQL', async () => {
        const tenantId = await newTenant('m-insert');
        const userId = await newUser('m-insert');
        await elevated(tenantId, () =>
          memberships.insert({
            tenantId,
            userId,
            roles: ['member', 'owner', 'member'],
            lastActiveAt: null,
          }),
        );
        await expect(as(tenantId, () => memberships.find(tenantId, userId))).resolves.toEqual({
          tenantId,
          userId,
          roles: ['owner', 'member'],
          lastActiveAt: null,
          createdAt: expect.any(Date),
        });
        await expect(
          as(tenantId, () => memberships.find(tenantId, generateId())),
        ).resolves.toBeNull();
        const emptyUser = await newUser('m-empty');
        await expect(
          as(tenantId, () =>
            memberships.insert({ tenantId, userId: emptyUser, roles: [], lastActiveAt: null }),
          ),
        ).rejects.toBeInstanceOf(InvalidRolesException);
      });

      it('maps the primary key to MembershipAlreadyExistsException', async () => {
        const tenantId = await newTenant('m-dupe');
        const userId = await newUser('m-dupe');
        await elevated(tenantId, () =>
          memberships.insert({ tenantId, userId, roles: ['member'], lastActiveAt: null }),
        );
        await expect(
          elevated(tenantId, () =>
            memberships.insert({ tenantId, userId, roles: ['admin'], lastActiveAt: null }),
          ),
        ).rejects.toBeInstanceOf(MembershipAlreadyExistsException);
      });

      it('orders by last_active_at desc (NULLs last), then newest first; touch moves one to the front', async () => {
        const userId = await newUser('m-order');
        const never = await newTenant('m-never');
        const old = await newTenant('m-old');
        const recent = await newTenant('m-recent');
        const join = (tenantId: string, lastActiveAt: Date | null, roles: ['member'] | ['admin']) =>
          elevated(tenantId, () => memberships.insert({ tenantId, userId, roles, lastActiveAt }));
        await join(never, null, ['member']);
        await join(old, new Date('2026-01-01T00:00:00Z'), ['member']);
        await join(recent, new Date('2026-02-01T00:00:00Z'), ['admin']);
        const asUser = <T>(tenantId: string | null, work: () => Promise<T>) =>
          as(tenantId, work, userId);
        await expect(
          asUser(null, () => memberships.findMostRecentForUser(userId)),
        ).resolves.toMatchObject({ tenantId: recent });
        // Every tenant of the user: the system read (the tenants policy shows the session tenant).
        const listed = await system(() => membershipsSystem.listForUser(userId));
        expect(listed.map((membership) => membership.tenantId)).toEqual([recent, old, never]);
        expect(listed[0]?.tenant).toMatchObject({ id: recent, slug: slug('m-recent') });
        // The runtime read joins only the session tenant's row.
        const runtime = await asUser(old, () => memberships.listForUser(userId));
        expect(runtime.map((membership) => membership.tenant.id)).toEqual([old]);
        await elevated(
          old,
          () => memberships.touch(old, userId, new Date('2026-03-01T00:00:00Z')),
          userId,
        );
        await expect(
          asUser(null, () => memberships.findMostRecentForUser(userId)),
        ).resolves.toMatchObject({ tenantId: old });
        await expect(as(null, () => memberships.findMostRecentForUser(ACTOR))).resolves.toBeNull();
      });

      it('enforces memberships_roles_not_empty in SQL and cascades tenant and user deletes', async () => {
        const db = admin();
        const tenantId = await newTenant('m-cascade');
        const userId = await newUser('m-cascade');
        const failure: unknown = await db
          .execute(
            sql`insert into identity.memberships (tenant_id, user_id, roles) values (${tenantId}, ${userId}, '{}')`,
          )
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        expect(constraintOf(failure)).toMatch(constraintNamed('memberships_roles_not_empty'));
        await elevated(tenantId, () =>
          memberships.insert({ tenantId, userId, roles: ['owner'], lastActiveAt: null }),
        );
        await db.execute(sql`delete from identity.tenants where id = ${tenantId}`);
        await expect(as(tenantId, () => memberships.find(tenantId, userId))).resolves.toBeNull();
        const other = await newTenant('m-cascade-2');
        await elevated(other, () =>
          memberships.insert({ tenantId: other, userId, roles: ['owner'], lastActiveAt: null }),
        );
        await db.execute(sql`delete from identity.users where id = ${userId}`);
        await expect(as(other, () => memberships.find(other, userId))).resolves.toBeNull();
      });
    });

    describe('invitations (tenant-distributed: every query carries tenant_id except the system read)', () => {
      const invite = async (tenantId: string, invitedBy: string, expiresAt: Date) => {
        const { token, tokenHash } = generateInvitationToken();
        const id = generateId();
        await elevated(tenantId, () =>
          invitations.insert({
            tenantId,
            id,
            email: `guest.${generateId().slice(-6)}@example.com`,
            roles: ['member'],
            tokenHash,
            invitedBy,
            expiresAt,
          }),
        );
        return { id, token, tokenHash };
      };

      it('findByTokenHash (system read) → listPending → markAccepted once', async () => {
        const tenantId = await newTenant('i-flow');
        const inviter = await newUser('i-flow');
        const now = new Date();
        const live = await invite(tenantId, inviter, new Date(now.getTime() + INVITATION_TTL_MS));
        const expired = await invite(tenantId, inviter, new Date(now.getTime() - 1_000));
        await expect(
          invitationsSystem.findByTokenHash(hashInvitationToken(live.token)),
        ).resolves.toMatchObject({
          tenantId,
          id: live.id,
          roles: ['member'],
          acceptedAt: null,
        });
        await expect(invitationsSystem.findByTokenHash(sha256Hex('unknown'))).resolves.toBeNull();
        const pending = await elevated(tenantId, () => invitations.listPending(tenantId, now));
        expect(pending.map((invitation) => invitation.id)).toEqual([live.id]);
        const accept = (id: string) =>
          elevated(tenantId, () => invitations.markAccepted(tenantId, id, now));
        await expect(accept(live.id)).resolves.toBe(true);
        await expect(accept(live.id)).resolves.toBe(false);
        await expect(accept(expired.id)).resolves.toBe(false);
        await expect(
          elevated(tenantId, () => invitations.listPending(tenantId, now)),
        ).resolves.toEqual([]);
        // Without elevation a member reads none (the invitations policy).
        await expect(as(tenantId, () => invitations.listPending(tenantId, now))).resolves.toEqual(
          [],
        );
      });

      it('is keyed (tenant_id, id) with a tenant-leading unique token hash', async () => {
        const tenantId = await newTenant('i-keys');
        const inviter = await newUser('i-keys');
        const first = await invite(tenantId, inviter, new Date(Date.now() + 60_000));
        const failure: unknown = await elevated(tenantId, () =>
          invitations.insert({
            tenantId,
            id: generateId(),
            email: 'x@example.com',
            roles: ['admin'],
            tokenHash: first.tokenHash,
            invitedBy: inviter,
            expiresAt: new Date(Date.now() + 60_000),
          }),
        ).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(constraintOf(failure)).toMatch(
          constraintNamed('invitations_tenant_id_token_hash_uq'),
        );
        const [pk] = await admin().execute<{ columns: string }>(sql`
          select string_agg(a.attname, ',' order by k.ord) as columns
          from pg_constraint c
          cross join lateral unnest(c.conkey) with ordinality as k(attnum, ord)
          join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
          where c.conname = 'invitations_tenant_id_id_pk'`);
        expect(pk?.columns).toBe('tenant_id,id');
      });

      describe('invitations accept (B2-14)', () => {
        it('two concurrent markAccepted calls: exactly one wins', async () => {
          const tenantId = await newTenant('i-race');
          const inviter = await newUser('i-race');
          const live = await invite(tenantId, inviter, new Date(Date.now() + INVITATION_TTL_MS));
          const now = new Date();
          const accept = () =>
            elevated(tenantId, () => invitations.markAccepted(tenantId, live.id, now));
          const results = await Promise.all([accept(), accept()]);
          expect(results.filter(Boolean)).toHaveLength(1);
        });

        it('findByTokenHash finds the invitation across tenants (pre-auth system read)', async () => {
          const [a, b] = [await newTenant('i-sys-a'), await newTenant('i-sys-b')] as [
            string,
            string,
          ];
          const inviter = await newUser('i-sys');
          const inA = await invite(a, inviter, new Date(Date.now() + INVITATION_TTL_MS));
          const inB = await invite(b, inviter, new Date(Date.now() + INVITATION_TTL_MS));
          // Under a principal of tenant A too: a pre-auth method runs anywhere.
          await expect(
            as(a, () => invitationsSystem.findByTokenHash(hashInvitationToken(inB.token))),
          ).resolves.toMatchObject({ tenantId: b, id: inB.id });
          await expect(
            invitationsSystem.findByTokenHash(hashInvitationToken(inA.token)),
          ).resolves.toMatchObject({ tenantId: a, id: inA.id });
        });
      });
    });

    describe('audit_events (append-only, tenant-distributed)', () => {
      it('appends and pages newest first within one tenant only', async () => {
        const tenantId = await newTenant('a-page');
        const otherTenant = await newTenant('a-other');
        const ids: string[] = [];
        for (const type of ['member.left', 'member.removed', 'staff.switch_in'] as const) {
          const id = generateId();
          ids.push(id);
          await as(tenantId, () =>
            auditEvents.append({
              tenantId,
              id,
              actorId: null,
              type,
              data: { n: ids.length },
              createdAt: new Date(),
            }),
          );
        }
        await as(otherTenant, () =>
          auditEvents.append({
            tenantId: otherTenant,
            id: generateId(),
            actorId: null,
            type: 'member.left',
            data: {},
            createdAt: new Date(),
          }),
        );
        // Reading the log needs elevation (the audit_events policy).
        await expect(
          as(tenantId, () => auditEvents.listForTenant(tenantId, { limit: 2 })),
        ).resolves.toMatchObject({ items: [] });
        const first = await elevated(tenantId, () =>
          auditEvents.listForTenant(tenantId, { limit: 2 }),
        );
        expect(first.items.map((event) => event.id)).toEqual([ids[2], ids[1]]);
        expect(first.items[0]).toMatchObject({
          tenantId,
          type: 'staff.switch_in',
          data: { n: 3 },
          actorId: null,
        });
        expect(first.nextCursor).not.toBeNull();
        const second = await elevated(tenantId, () =>
          auditEvents.listForTenant(tenantId, { limit: 2, cursor: first.nextCursor ?? undefined }),
        );
        expect(second.items.map((event) => event.id)).toEqual([ids[0]]);
        expect(second.nextCursor).toBeNull();
      });

      it('keeps actor_id without a foreign key (history outlives users) and defaults data to {}', async () => {
        const tenantId = await newTenant('a-actor');
        const [row] = await admin().execute<{ data: unknown }>(sql`
          insert into identity.audit_events (tenant_id, actor_id, type)
          values (${tenantId}, ${generateId()}, 'member.left') returning data`);
        expect(row?.data).toEqual({});
      });
    });

    describe('members (B2-13)', () => {
      it('listMembers (system read) pages inside the tenant with user profiles; updateRoles and delete report a match', async () => {
        const tenantId = await newTenant('members');
        const ids = [await newUser('m1'), await newUser('m2'), await newUser('m3')];
        for (const userId of ids) {
          await elevated(tenantId, () =>
            memberships.insert({ tenantId, userId, roles: ['member'], lastActiveAt: null }),
          );
        }
        const first = await system(() => membershipsSystem.listMembers(tenantId, { limit: 2 }));
        expect(first.items.map((m) => m.userId)).toEqual([...ids].sort().reverse().slice(0, 2));
        expect(first.items[0]).toMatchObject({
          email: expect.stringContaining('@'),
          roles: ['member'],
        });
        const rest = await system(() =>
          membershipsSystem.listMembers(tenantId, {
            limit: 2,
            cursor: first.nextCursor ?? undefined,
          }),
        );
        expect(rest.items).toHaveLength(1);
        await expect(
          elevated(tenantId, () => memberships.updateRoles(tenantId, ids[0] as string, ['admin'])),
        ).resolves.toBe(true);
        await expect(
          elevated(tenantId, () =>
            memberships.updateRoles(generateId(), ids[0] as string, ['admin']),
          ),
        ).resolves.toBe(false);
        await expect(
          elevated(tenantId, () => memberships.delete(tenantId, ids[1] as string)),
        ).resolves.toBe(true);
        await expect(
          system(() => membershipsSystem.findMember(tenantId, ids[1] as string)),
        ).resolves.toBeNull();
        await expect(
          system(() => membershipsSystem.findMember(tenantId, ids[0] as string)),
        ).resolves.toMatchObject({ userId: ids[0], roles: ['admin'] });
      });

      it('countOwnersLocked serialises owner changes: two owners demoting each other leave exactly one', async () => {
        const tenantId = await newTenant('owners');
        const [a, b] = [await newUser('oa'), await newUser('ob')] as [string, string];
        for (const userId of [a, b]) {
          await elevated(tenantId, () =>
            memberships.insert({ tenantId, userId, roles: ['owner'], lastActiveAt: null }),
          );
        }
        // One unit of work each: the advisory lock is held until its COMMIT.
        const demote = (target: string) =>
          elevated(tenantId, async () => {
            const owners = await memberships.countOwnersLocked(tenantId);
            await new Promise((resolve) => setTimeout(resolve, 100)); // hold the lock
            if (owners <= 1) return false;
            return memberships.updateRoles(tenantId, target, ['admin']);
          });
        const results = await Promise.all([demote(a), demote(b)]);
        expect(results.filter(Boolean)).toHaveLength(1);
        await expect(as(tenantId, () => memberships.countOwnersLocked(tenantId))).resolves.toBe(1);
      });
    });
  },
);

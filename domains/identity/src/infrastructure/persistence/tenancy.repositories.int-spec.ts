import { generateId, isUuidV7, PLATFORM_TENANT_ID, sha256Hex } from '@platform/common';
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
import { DrizzleMembershipsRepository } from './drizzle-memberships.repository.js';
import { DrizzleTenantsRepository } from './drizzle-tenants.repository.js';
import { DrizzleTransactionRunner } from './drizzle-transaction.runner.js';
import { DrizzleUsersRepository } from './drizzle-users.repository.js';

/*
 * identity's tenancy repositories against Citus 14.2 (single node, @platform/testing/postgres) with
 * identity's real migration history. Opt-in: INTEGRATION=1 npx vitest run --project identity:int tenancy
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
    let transactions: DrizzleTransactionRunner;
    const run = generateId().slice(-8);
    const slug = (name: string): string => `${name}-${run}`;

    beforeAll(async () => {
      database = await startIdentityDatabase(
        [
          DrizzleTenantsRepository,
          DrizzleMembershipsRepository,
          DrizzleInvitationsRepository,
          DrizzleAuditEventsRepository,
          DrizzleTransactionRunner,
          DrizzleUsersRepository,
        ],
        { localExecution: false },
      );
      tenants = database.app.get(DrizzleTenantsRepository);
      memberships = database.app.get(DrizzleMembershipsRepository);
      invitations = database.app.get(DrizzleInvitationsRepository);
      auditEvents = database.app.get(DrizzleAuditEventsRepository);
      transactions = database.app.get(DrizzleTransactionRunner);
    });

    afterAll(async () => {
      await database?.close();
    });

    const newTenant = async (name: string, personal = false): Promise<string> => {
      const id = generateId();
      await tenants.insert({ id, slug: slug(name), name: `${name} workspace`, personal });
      return id;
    };

    describe('tenants', () => {
      it('insert → findById / findByIds / existsBySlug / rename', async () => {
        const id = await newTenant('acme', true);
        await expect(tenants.findById(id)).resolves.toMatchObject({
          id,
          slug: slug('acme'),
          name: 'acme workspace',
          personal: true,
          createdAt: expect.any(Date),
        });
        const other = await newTenant('globex');
        const found = await tenants.findByIds([id, other, generateId()]);
        expect(found.map((tenant) => tenant.id).sort()).toEqual([id, other].sort());
        await expect(tenants.findByIds([])).resolves.toEqual([]);
        await expect(tenants.existsBySlug(slug('acme'))).resolves.toBe(true);
        await expect(tenants.existsBySlug(slug('nope'))).resolves.toBe(false);
        await expect(tenants.rename(id, 'Acme Inc.')).resolves.toBe(true);
        await expect(tenants.findById(id)).resolves.toMatchObject({ name: 'Acme Inc.' });
        await expect(tenants.rename(generateId(), 'x')).resolves.toBe(false);
      });

      it('maps tenants_slug_unique to TenantSlugTakenException', async () => {
        await newTenant('dupe');
        await expect(
          tenants.insert({ id: generateId(), slug: slug('dupe'), name: 'x', personal: false }),
        ).rejects.toBeInstanceOf(TenantSlugTakenException);
      });

      it('refuses the platform tenant id (tenants_id_not_platform)', async () => {
        const failure: unknown = await tenants
          .insert({
            id: PLATFORM_TENANT_ID,
            slug: slug('platform'),
            name: 'Platform',
            personal: false,
          })
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        expect(constraintOf(failure)).toMatch(constraintNamed('tenants_id_not_platform'));
      });

      it('defaults id (uuidv7) and personal = false for raw SQL inserts', async () => {
        const [row] = await (database as IdentityDatabase).db.execute<{
          id: string;
          personal: boolean;
        }>(
          sql`insert into identity.tenants (slug, name) values (${slug('raw')}, 'Raw') returning id, personal`,
        );
        expect(isUuidV7(row?.id)).toBe(true);
        expect(row?.personal).toBe(false);
      });
    });

    /** A user row by raw SQL (no dependency on the users repository's shape, which Task 11 changes). */
    const newUser = async (name: string): Promise<string> => {
      const [row] = await (database as IdentityDatabase).db.execute<{ id: string }>(sql`
      insert into identity.users (email, password_hash, display_name)
      values (${`${name}.${run}@example.com`}, 'x', ${name}) returning id`);
      if (row === undefined) throw new Error('user insert returned nothing');
      return row.id;
    };

    describe('memberships', () => {
      it('insert → find, roles normalized; empty roles refused before any SQL', async () => {
        const tenantId = await newTenant('m-insert');
        const userId = await newUser('m-insert');
        await memberships.insert({
          tenantId,
          userId,
          roles: ['member', 'owner', 'member'],
          lastActiveAt: null,
        });
        await expect(memberships.find(tenantId, userId)).resolves.toEqual({
          tenantId,
          userId,
          roles: ['owner', 'member'],
          lastActiveAt: null,
          createdAt: expect.any(Date),
        });
        await expect(memberships.find(tenantId, generateId())).resolves.toBeNull();
        await expect(
          memberships.insert({
            tenantId,
            userId: await newUser('m-empty'),
            roles: [],
            lastActiveAt: null,
          }),
        ).rejects.toBeInstanceOf(InvalidRolesException);
      });

      it('maps the primary key to MembershipAlreadyExistsException', async () => {
        const tenantId = await newTenant('m-dupe');
        const userId = await newUser('m-dupe');
        await memberships.insert({ tenantId, userId, roles: ['member'], lastActiveAt: null });
        await expect(
          memberships.insert({ tenantId, userId, roles: ['admin'], lastActiveAt: null }),
        ).rejects.toBeInstanceOf(MembershipAlreadyExistsException);
      });

      it('orders by last_active_at desc (NULLs last), then newest first; touch moves one to the front', async () => {
        const userId = await newUser('m-order');
        const never = await newTenant('m-never');
        const old = await newTenant('m-old');
        const recent = await newTenant('m-recent');
        await memberships.insert({
          tenantId: never,
          userId,
          roles: ['member'],
          lastActiveAt: null,
        });
        await memberships.insert({
          tenantId: old,
          userId,
          roles: ['member'],
          lastActiveAt: new Date('2026-01-01T00:00:00Z'),
        });
        await memberships.insert({
          tenantId: recent,
          userId,
          roles: ['admin'],
          lastActiveAt: new Date('2026-02-01T00:00:00Z'),
        });
        await expect(memberships.findMostRecentForUser(userId)).resolves.toMatchObject({
          tenantId: recent,
        });
        const listed = await memberships.listForUser(userId);
        expect(listed.map((membership) => membership.tenantId)).toEqual([recent, old, never]);
        expect(listed[0]?.tenant).toMatchObject({ id: recent, slug: slug('m-recent') });
        await memberships.touch(old, userId, new Date('2026-03-01T00:00:00Z'));
        await expect(memberships.findMostRecentForUser(userId)).resolves.toMatchObject({
          tenantId: old,
        });
        await expect(memberships.findMostRecentForUser(generateId())).resolves.toBeNull();
      });

      it('enforces memberships_roles_not_empty in SQL and cascades tenant and user deletes', async () => {
        const db = (database as IdentityDatabase).db;
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
        await memberships.insert({ tenantId, userId, roles: ['owner'], lastActiveAt: null });
        await db.execute(sql`delete from identity.tenants where id = ${tenantId}`);
        await expect(memberships.find(tenantId, userId)).resolves.toBeNull();
        const other = await newTenant('m-cascade-2');
        await memberships.insert({ tenantId: other, userId, roles: ['owner'], lastActiveAt: null });
        await db.execute(sql`delete from identity.users where id = ${userId}`);
        await expect(memberships.find(other, userId)).resolves.toBeNull();
      });
    });

    describe('invitations (tenant-distributed: every query carries tenant_id except the system read)', () => {
      const invite = async (tenantId: string, invitedBy: string, expiresAt: Date) => {
        const { token, tokenHash } = generateInvitationToken();
        const id = generateId();
        await invitations.insert({
          tenantId,
          id,
          email: `guest.${generateId().slice(-6)}@example.com`,
          roles: ['member'],
          tokenHash,
          invitedBy,
          expiresAt,
        });
        return { id, token, tokenHash };
      };

      it('findByTokenHash (system read) → listPending → markAccepted once', async () => {
        const tenantId = await newTenant('i-flow');
        const inviter = await newUser('i-flow');
        const now = new Date();
        const live = await invite(tenantId, inviter, new Date(now.getTime() + INVITATION_TTL_MS));
        const expired = await invite(tenantId, inviter, new Date(now.getTime() - 1_000));
        await expect(
          invitations.findByTokenHash(hashInvitationToken(live.token)),
        ).resolves.toMatchObject({
          tenantId,
          id: live.id,
          roles: ['member'],
          acceptedAt: null,
        });
        await expect(invitations.findByTokenHash(sha256Hex('unknown'))).resolves.toBeNull();
        const pending = await invitations.listPending(tenantId, now);
        expect(pending.map((invitation) => invitation.id)).toEqual([live.id]);
        await expect(invitations.markAccepted(tenantId, live.id, now)).resolves.toBe(true);
        await expect(invitations.markAccepted(tenantId, live.id, now)).resolves.toBe(false);
        await expect(invitations.markAccepted(tenantId, expired.id, now)).resolves.toBe(false);
        await expect(invitations.listPending(tenantId, now)).resolves.toEqual([]);
      });

      it('is keyed (tenant_id, id) with a tenant-leading unique token hash', async () => {
        const tenantId = await newTenant('i-keys');
        const inviter = await newUser('i-keys');
        const first = await invite(tenantId, inviter, new Date(Date.now() + 60_000));
        const failure: unknown = await invitations
          .insert({
            tenantId,
            id: generateId(),
            email: 'x@example.com',
            roles: ['admin'],
            tokenHash: first.tokenHash,
            invitedBy: inviter,
            expiresAt: new Date(Date.now() + 60_000),
          })
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        expect(constraintOf(failure)).toMatch(
          constraintNamed('invitations_tenant_id_token_hash_uq'),
        );
        const [pk] = await (database as IdentityDatabase).db.execute<{ columns: string }>(sql`
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
          const results = await Promise.all([
            invitations.markAccepted(tenantId, live.id, now),
            invitations.markAccepted(tenantId, live.id, now),
          ]);
          expect(results.filter(Boolean)).toHaveLength(1);
        });

        it('findByTokenHash finds the invitation across tenants (system read)', async () => {
          const [a, b] = [await newTenant('i-sys-a'), await newTenant('i-sys-b')] as [
            string,
            string,
          ];
          const inviter = await newUser('i-sys');
          const inA = await invite(a, inviter, new Date(Date.now() + INVITATION_TTL_MS));
          const inB = await invite(b, inviter, new Date(Date.now() + INVITATION_TTL_MS));
          await expect(
            invitations.findByTokenHash(hashInvitationToken(inA.token)),
          ).resolves.toMatchObject({ tenantId: a, id: inA.id });
          await expect(
            invitations.findByTokenHash(hashInvitationToken(inB.token)),
          ).resolves.toMatchObject({ tenantId: b, id: inB.id });
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
          await auditEvents.append({
            tenantId,
            id,
            actorId: null,
            type,
            data: { n: ids.length },
            createdAt: new Date(),
          });
        }
        await auditEvents.append({
          tenantId: otherTenant,
          id: generateId(),
          actorId: null,
          type: 'member.left',
          data: {},
          createdAt: new Date(),
        });
        const first = await auditEvents.listForTenant(tenantId, { limit: 2 });
        expect(first.items.map((event) => event.id)).toEqual([ids[2], ids[1]]);
        expect(first.items[0]).toMatchObject({
          tenantId,
          type: 'staff.switch_in',
          data: { n: 3 },
          actorId: null,
        });
        expect(first.nextCursor).not.toBeNull();
        const second = await auditEvents.listForTenant(tenantId, {
          limit: 2,
          cursor: first.nextCursor ?? undefined,
        });
        expect(second.items.map((event) => event.id)).toEqual([ids[0]]);
        expect(second.nextCursor).toBeNull();
      });

      it('keeps actor_id without a foreign key (history outlives users) and defaults data to {}', async () => {
        const tenantId = await newTenant('a-actor');
        const [row] = await (database as IdentityDatabase).db.execute<{ data: unknown }>(sql`
          insert into identity.audit_events (tenant_id, actor_id, type)
          values (${tenantId}, ${generateId()}, 'member.left') returning data`);
        expect(row?.data).toEqual({});
      });
    });

    describe('members (B2-13)', () => {
      it('listMembers pages inside the tenant with user profiles; updateRoles and delete report a match', async () => {
        const tenantId = await newTenant('members');
        const ids = [await newUser('m1'), await newUser('m2'), await newUser('m3')];
        for (const userId of ids) {
          await memberships.insert({ tenantId, userId, roles: ['member'], lastActiveAt: null });
        }
        const first = await memberships.listMembers(tenantId, { limit: 2 });
        expect(first.items.map((m) => m.userId)).toEqual([...ids].sort().reverse().slice(0, 2));
        expect(first.items[0]).toMatchObject({
          email: expect.stringContaining('@'),
          roles: ['member'],
        });
        const rest = await memberships.listMembers(tenantId, {
          limit: 2,
          cursor: first.nextCursor ?? undefined,
        });
        expect(rest.items).toHaveLength(1);
        await expect(memberships.updateRoles(tenantId, ids[0] as string, ['admin'])).resolves.toBe(
          true,
        );
        await expect(
          memberships.updateRoles(generateId(), ids[0] as string, ['admin']),
        ).resolves.toBe(false);
        await expect(memberships.delete(tenantId, ids[1] as string)).resolves.toBe(true);
        await expect(memberships.findMember(tenantId, ids[1] as string)).resolves.toBeNull();
      });

      it('countOwnersLocked serialises owner changes: two owners demoting each other leave exactly one', async () => {
        const tenantId = await newTenant('owners');
        const [a, b] = [await newUser('oa'), await newUser('ob')] as [string, string];
        await memberships.insert({ tenantId, userId: a, roles: ['owner'], lastActiveAt: null });
        await memberships.insert({ tenantId, userId: b, roles: ['owner'], lastActiveAt: null });
        const demote = (target: string) =>
          transactions.run(async () => {
            const owners = await memberships.countOwnersLocked(tenantId);
            await new Promise((resolve) => setTimeout(resolve, 100)); // hold the lock
            if (owners <= 1) return false;
            return memberships.updateRoles(tenantId, target, ['admin']);
          });
        const results = await Promise.all([demote(a), demote(b)]);
        expect(results.filter(Boolean)).toHaveLength(1);
        await expect(memberships.countOwnersLocked(tenantId)).resolves.toBe(1);
      });
    });
  },
);

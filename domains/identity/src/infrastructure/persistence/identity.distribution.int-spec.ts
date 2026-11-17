import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LoggerService } from '@nestjs/common';
import { generateId } from '@platform/common';
import {
  type DrizzleTransactionalAdapter,
  runMigrations,
  type TransactionHost,
  withPlatformMigrations,
} from '@platform/database';
import { type RlsTestPostgres, startRlsTestPostgres } from '@platform/testing/postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NewMembership } from '../../application/persistence/memberships.repository.js';
import {
  EmailAlreadyTakenException,
  MembershipAlreadyExistsException,
  TenantSlugTakenException,
} from '../../domain/identity.errors.js';
import { UserAggregate } from '../../domain/user.aggregate.js';
import { IdentityErrorCode } from '../../identity.constants.js';
import { DrizzleMembershipsRepository } from './drizzle-memberships.repository.js';
import { DrizzleSessionsRepository } from './drizzle-sessions.repository.js';
import { DrizzleTenantsRepository } from './drizzle-tenants.repository.js';
import { DrizzleUsersRepository } from './drizzle-users.repository.js';
import { identityMigrations } from './identity.migrations.js';
import { type IdentitySchema, identitySchema } from './identity.schema.js';

/*
 * SH-5: identity's distribution migration (0008_distribute) on Citus 14.2, single node, local
 * execution off (startRlsTestPostgres), so every shard statement goes over a remote connection as
 * on a cluster. The platform set and identity's whole history are applied as `app_owner` on a fresh
 * database by the real runner, in one transaction per set: the runner switches local execution on
 * for its own session, so the shards of a schema created earlier in the same transaction are
 * created over the coordinator's own connection. Seeding and the repository use the superuser `url`:
 * the runtime and system roles get their grants only with the identity RLS migration.
 * Opt-in (needs Docker): INTEGRATION=1 bunx vitest run --project identity:int distribution
 */

const silent: LoggerService = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const IDENTITY_TABLES = [
  'identity.users',
  'identity.tenants',
  'identity.memberships',
  'identity.invitations',
  'identity.audit_events',
  'identity.sessions',
] as const;

interface DistributionRow {
  table: string;
  kind: string | null;
  colocation: number | null;
  shards: number;
}

const constraintOf = (error: unknown): unknown =>
  (error as { constraint_name?: unknown } | undefined)?.constraint_name;
const codeOf = (error: unknown): unknown => (error as { code?: unknown } | undefined)?.code;
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : '');

describe.skipIf(process.env['INTEGRATION'] !== '1')(
  'identity distribution migration (SH-5) on Citus',
  () => {
    let pg: RlsTestPostgres | undefined;
    let admin: Sql;
    let owner: Sql;
    let repositoryClient: Sql;
    let sessions: DrizzleSessionsRepository;
    let users: DrizzleUsersRepository;
    let tenants: DrizzleTenantsRepository;
    let memberships: DrizzleMembershipsRepository;

    const migrate = () =>
      runMigrations(pg?.migrationUrl ?? '', {
        migrations: withPlatformMigrations([identityMigrations]),
        logger: silent,
        applicationName: 'identity-distribution-int',
      });

    /** Kind, colocation group and shard count of every identity table, plus the tenant anchor. */
    const distribution = async (): Promise<DistributionRow[]> =>
      admin<DistributionRow[]>`
        select t.name as "table", app.citus_table_kind(t.name::regclass) as kind,
          (select p.colocationid from pg_dist_partition p
            where p.logicalrelid = t.name::regclass)::int as colocation,
          (select count(*) from pg_dist_shard s where s.logicalrelid = t.name::regclass)::int as shards
        from unnest(${[...IDENTITY_TABLES, 'app.tenant_colocation']}::text[])
          with ordinality as t(name, position)
        order by t.position`;

    beforeAll(async () => {
      pg = await startRlsTestPostgres();
      admin = postgres(pg.url, { max: 2, onnotice: () => undefined });
      owner = postgres(pg.migrationUrl, { max: 1, onnotice: () => undefined });
      await migrate();
      // Its own client: drizzle replaces the client's Date serializers, which raw inserts use.
      repositoryClient = postgres(pg.url, { max: 1, onnotice: () => undefined });
      const db = drizzle({
        client: repositoryClient,
        schema: identitySchema,
        casing: 'snake_case',
      });
      const txHost = { tx: db } as unknown as TransactionHost<
        DrizzleTransactionalAdapter<IdentitySchema>
      >;
      sessions = new DrizzleSessionsRepository(txHost);
      users = new DrizzleUsersRepository(db, txHost);
      tenants = new DrizzleTenantsRepository(txHost);
      memberships = new DrizzleMembershipsRepository(txHost);
    });

    afterAll(async () => {
      await repositoryClient?.end({ timeout: 5 });
      await owner?.end({ timeout: 5 });
      await admin?.end({ timeout: 5 });
      await pg?.stop();
    });

    it('runs with local execution off (as on a cluster)', async () => {
      const [row] = await admin<{ setting: string }[]>`
        select current_setting('citus.enable_local_execution') as setting`;
      expect(row?.setting).toBe('off');
    });

    it('makes users, tenants and memberships reference tables', async () => {
      const rows = await distribution();
      expect(rows.slice(0, 3).map(({ table, kind }) => ({ table, kind }))).toEqual([
        { table: 'identity.users', kind: 'reference' },
        { table: 'identity.tenants', kind: 'reference' },
        { table: 'identity.memberships', kind: 'reference' },
      ]);
    });

    it('distributes invitations and audit_events by tenant_id, colocated with app.tenant_colocation', async () => {
      const byTable = new Map((await distribution()).map((row) => [row.table, row]));
      const anchor = byTable.get('app.tenant_colocation');
      expect(anchor?.kind).toBe('hash:tenant_id');
      expect(anchor?.colocation).toEqual(expect.any(Number));
      for (const table of ['identity.invitations', 'identity.audit_events']) {
        expect(byTable.get(table)).toMatchObject({
          kind: 'hash:tenant_id',
          colocation: anchor?.colocation,
          shards: anchor?.shards,
        });
      }
    });

    it('distributes sessions by user_id in its own colocation group', async () => {
      const byTable = new Map((await distribution()).map((row) => [row.table, row]));
      const session = byTable.get('identity.sessions');
      expect(session?.kind).toBe('hash:user_id');
      expect(session?.colocation).toEqual(expect.any(Number));
      expect(session?.colocation).not.toBe(byTable.get('app.tenant_colocation')?.colocation);
      expect(session?.shards).toBeGreaterThan(1);
    });

    it('is a no-op when applied twice: by the runner, and by re-running 0008 itself', async () => {
      const before = await distribution();

      const again = await migrate();
      expect(again.applied).toBe(0);

      const statements = readFileSync(
        join(identityMigrations.folder, '0008_distribute.sql'),
        'utf8',
      )
        .split('--> statement-breakpoint')
        .map((statement) => statement.trim())
        .filter((statement) => statement !== '');
      expect(statements).toHaveLength(IDENTITY_TABLES.length);
      await owner.begin(async (tx) => {
        for (const statement of statements) await tx.unsafe(statement);
      });

      expect(await distribution()).toEqual(before);
    });

    it('deleteExpired removes exactly the expired sessions of users on different shards, in one DELETE', async () => {
      const tenantId = generateId();
      await admin`insert into identity.tenants (id, slug, name)
        values (${tenantId}, ${`purge-${tenantId.slice(-8)}`}, 'purge')`;

      // Three users whose sessions hash to three different shards.
      const userIds: string[] = [];
      const shards = new Set<string>();
      while (userIds.length < 3) {
        const id = generateId();
        const [row] = await admin<{ shard: string }[]>`
          select get_shard_id_for_distribution_column('identity.sessions', ${id}::uuid)::text as shard`;
        if (row === undefined || shards.has(row.shard)) continue;
        shards.add(row.shard);
        userIds.push(id);
      }
      for (const id of userIds) {
        await admin`insert into identity.users (id, email, password_hash, display_name)
          values (${id}, ${`purge-${id}@example.com`}, 'hash', 'Purge')`;
      }

      const now = new Date('2026-11-17T12:00:00.000Z');
      const at = (offsetMs: number): Date => new Date(now.getTime() + offsetMs);
      const kept: string[] = [];
      for (const userId of userIds) {
        const rows = [
          { id: generateId(), expiresAt: at(-60_000), revokedAt: null, expired: true },
          { id: generateId(), expiresAt: now, revokedAt: null, expired: true },
          { id: generateId(), expiresAt: at(60_000), revokedAt: null, expired: false },
          // Revoked but unexpired: kept, so a replayed rotated token stays detectable.
          { id: generateId(), expiresAt: at(60_000), revokedAt: at(-1_000), expired: false },
        ];
        for (const row of rows) {
          await admin`insert into identity.sessions
              (id, user_id, tenant_id, refresh_token_hash, expires_at, revoked_at)
            values (${row.id}, ${userId}, ${tenantId}, ${'h'.repeat(64)}, ${row.expiresAt},
              ${row.revokedAt})`;
          if (!row.expired) kept.push(row.id);
        }
      }

      await expect(sessions.deleteExpired(now)).resolves.toBe(6);

      const left = await admin<{ id: string }[]>`
        select id::text from identity.sessions where user_id = any(${userIds}::uuid[])`;
      expect(left.map(({ id }) => id).sort()).toEqual([...kept].sort());
      await expect(sessions.deleteExpired(now)).resolves.toBe(0);
    });

    it('still rejects a duplicate email and a duplicate slug (global uniques on reference tables)', async () => {
      const email = `dup-${generateId()}@example.com`;
      await admin`insert into identity.users (email, password_hash, display_name)
        values (${email}, 'hash', 'One')`;
      const duplicateEmail =
        await admin`insert into identity.users (email, password_hash, display_name)
        values (${email}, 'hash', 'Two')`.catch((error: unknown) => error);
      expect(codeOf(duplicateEmail)).toBe('23505');
      // Relayed from the shard: no constraint_name, the message names the shard's constraint.
      expect(constraintOf(duplicateEmail)).toBeUndefined();
      expect(messageOf(duplicateEmail)).toMatch(/unique constraint "users_email_unique_\d+"/);

      const slug = `dup-${generateId().slice(-12)}`;
      await admin`insert into identity.tenants (slug, name) values (${slug}, 'One')`;
      const duplicateSlug = await admin`insert into identity.tenants (slug, name)
        values (${slug}, 'Two')`.catch((error: unknown) => error);
      expect(codeOf(duplicateSlug)).toBe('23505');
      expect(messageOf(duplicateSlug)).toMatch(/unique constraint "tenants_slug_unique_\d+"/);
    });

    it('maps the relayed shard violations to EMAIL_TAKEN, TENANT_SLUG_TAKEN and MEMBERSHIP_EXISTS', async () => {
      const register = (email: string): UserAggregate =>
        UserAggregate.register({
          id: generateId(),
          email,
          displayName: 'Mapped',
          passwordHash: 'hash',
          now: new Date(),
        });
      const email = `mapped-${generateId()}@example.com`;
      const user = register(email);
      await users.insert(user);
      const emailTaken = await users.insert(register(email)).catch((error: unknown) => error);
      expect(emailTaken).toBeInstanceOf(EmailAlreadyTakenException);
      expect(emailTaken).toMatchObject({ code: IdentityErrorCode.EMAIL_TAKEN });

      const slug = `mapped-${generateId().slice(-12)}`;
      const tenantId = generateId();
      await tenants.insert({ id: tenantId, slug, name: 'Mapped', personal: false });
      const slugTaken = await tenants
        .insert({ id: generateId(), slug, name: 'Mapped again', personal: false })
        .catch((error: unknown) => error);
      expect(slugTaken).toBeInstanceOf(TenantSlugTakenException);
      expect(slugTaken).toMatchObject({ code: IdentityErrorCode.TENANT_SLUG_TAKEN });

      const membership: NewMembership = {
        tenantId,
        userId: user.id,
        roles: ['owner'],
        lastActiveAt: null,
      };
      await memberships.insert(membership);
      const membershipExists = await memberships
        .insert(membership)
        .catch((error: unknown) => error);
      expect(membershipExists).toBeInstanceOf(MembershipAlreadyExistsException);
      expect(membershipExists).toMatchObject({ code: IdentityErrorCode.MEMBERSHIP_EXISTS });
    });
  },
);

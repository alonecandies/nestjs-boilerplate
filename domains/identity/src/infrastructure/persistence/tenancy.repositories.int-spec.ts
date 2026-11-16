import { generateId, isUuidV7, PLATFORM_TENANT_ID } from '@platform/common';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type IdentityDatabase, startIdentityDatabase } from '../../../test/identity-database.js';
import {
  InvalidRolesException,
  MembershipAlreadyExistsException,
  TenantSlugTakenException,
} from '../../domain/identity.errors.js';
import { DrizzleMembershipsRepository } from './drizzle-memberships.repository.js';
import { DrizzleTenantsRepository } from './drizzle-tenants.repository.js';

/*
 * identity's tenancy repositories against Citus 14.2 (single node, @platform/testing/postgres) with
 * identity's real migration history. Opt-in: INTEGRATION=1 npx vitest run --project identity:int tenancy
 * The tables are not distributed here (SH-5 adds the distribution calls); every query already carries
 * its distribution column (sharding design §2.1).
 */

const constraintOf = (error: unknown): unknown =>
  (error as { cause?: { constraint_name?: unknown } } | undefined)?.cause?.constraint_name;

describe.skipIf(process.env['INTEGRATION'] !== '1')(
  'identity tenancy repositories on Citus',
  () => {
    let database: IdentityDatabase | undefined;
    let tenants: DrizzleTenantsRepository;
    let memberships: DrizzleMembershipsRepository;
    const run = generateId().slice(-8);
    const slug = (name: string): string => `${name}-${run}`;

    beforeAll(async () => {
      database = await startIdentityDatabase([
        DrizzleTenantsRepository,
        DrizzleMembershipsRepository,
      ]);
      tenants = database.app.get(DrizzleTenantsRepository);
      memberships = database.app.get(DrizzleMembershipsRepository);
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
        expect(constraintOf(failure)).toBe('tenants_id_not_platform');
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
        expect(constraintOf(failure)).toBe('memberships_roles_not_empty');
        await memberships.insert({ tenantId, userId, roles: ['owner'], lastActiveAt: null });
        await db.execute(sql`delete from identity.tenants where id = ${tenantId}`);
        await expect(memberships.find(tenantId, userId)).resolves.toBeNull();
        const other = await newTenant('m-cascade-2');
        await memberships.insert({ tenantId: other, userId, roles: ['owner'], lastActiveAt: null });
        await db.execute(sql`delete from identity.users where id = ${userId}`);
        await expect(memberships.find(other, userId)).resolves.toBeNull();
      });
    });
  },
);

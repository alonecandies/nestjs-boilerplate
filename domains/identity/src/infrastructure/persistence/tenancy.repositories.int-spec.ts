import { generateId, isUuidV7 } from '@platform/common';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type IdentityDatabase, startIdentityDatabase } from '../../../test/identity-database.js';
import { TenantSlugTakenException } from '../../domain/identity.errors.js';
import { DrizzleTenantsRepository } from './drizzle-tenants.repository.js';

/*
 * identity's tenancy repositories against Citus 14.2 (single node, @platform/testing/postgres) with
 * identity's real migration history. Opt-in: INTEGRATION=1 npx vitest run --project identity:int tenancy
 * The tables are not distributed here (SH-5 adds the distribution calls); every query already carries
 * its distribution column (sharding design §2.1).
 */

// = PLATFORM_TENANT_ID (@platform/common, Task 1 / Lane P; not in this lane's base yet).
const PLATFORM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

const constraintOf = (error: unknown): unknown =>
  (error as { cause?: { constraint_name?: unknown } } | undefined)?.cause?.constraint_name;

describe.skipIf(process.env['INTEGRATION'] !== '1')(
  'identity tenancy repositories on Citus',
  () => {
    let database: IdentityDatabase | undefined;
    let tenants: DrizzleTenantsRepository;
    const run = generateId().slice(-8);
    const slug = (name: string): string => `${name}-${run}`;

    beforeAll(async () => {
      database = await startIdentityDatabase([DrizzleTenantsRepository]);
      tenants = database.app.get(DrizzleTenantsRepository);
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
  },
);

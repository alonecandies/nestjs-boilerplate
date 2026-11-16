import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MIGRATIONS_TABLE } from '@platform/database';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import drizzleConfig from '../../../drizzle.config.js';
import { identityMigrations } from './identity.migrations.js';
import { identityPgSchema, sessions, tenants, userRole, users } from './identity.schema.js';

// = PLATFORM_TENANT_ID (@platform/common, Task 1 / Lane P; not in this lane's base yet).
const PLATFORM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

describe('identityMigrations', () => {
  it("is identity's own history: ./migrations, bookkeeping in identity.__drizzle_migrations", () => {
    expect(identityMigrations).toEqual({
      name: 'identity',
      folder: join(import.meta.dirname, 'migrations'),
      migrationsSchema: 'identity',
      migrationsTable: MIGRATIONS_TABLE,
    });
  });

  it('keeps every identity table and enum in the identity Postgres schema', () => {
    expect(identityPgSchema.schemaName).toBe(identityMigrations.migrationsSchema);
    expect([users, sessions, tenants].map((table) => getTableConfig(table).schema)).toEqual(
      Array(3).fill('identity'),
    );
    expect(userRole.schema).toBe('identity');
  });

  it('matches drizzle.config.ts: output folder, schema filter, bookkeeping table', () => {
    expect(resolve(drizzleConfig.out ?? '')).toBe(identityMigrations.folder);
    expect(drizzleConfig.schemaFilter).toEqual([identityMigrations.migrationsSchema]);
    expect(drizzleConfig.migrations).toEqual({
      schema: identityMigrations.migrationsSchema,
      table: identityMigrations.migrationsTable,
    });
  });

  it('creates its schema idempotently (the migrator creates it first) and carries the trigram index', () => {
    const baseline = readFileSync(join(identityMigrations.folder, '0000_init.sql'), 'utf8');
    expect(baseline).toContain('CREATE SCHEMA IF NOT EXISTS "identity";');
    expect(baseline).not.toMatch(/^CREATE SCHEMA "identity";/m);
    expect(baseline).toContain(
      'CREATE INDEX "users_search_trgm_idx" ON "identity"."users" USING gin',
    );
  });

  it('0001_tenants refuses the platform tenant id (tenants_id_not_platform = PLATFORM_TENANT_ID)', () => {
    const sql = readFileSync(join(identityMigrations.folder, '0001_tenants.sql'), 'utf8');
    expect(sql).toContain(
      `CONSTRAINT "tenants_id_not_platform" CHECK ("id" <> '${PLATFORM_TENANT_ID}'::uuid)`,
    );
    expect(sql).toContain('CONSTRAINT "tenants_slug_unique" UNIQUE("slug")');
  });
});

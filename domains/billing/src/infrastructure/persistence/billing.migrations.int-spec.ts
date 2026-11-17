import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type INestApplicationContext, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { generateId, isUuidV7 } from '@platform/common';
import { AppConfigModule } from '@platform/config';
import {
  type DatabaseMigrationSet,
  DatabaseModule,
  DRIZZLE,
  type DrizzleDB,
  platformMigrations,
} from '@platform/database';
import { readRolesInitSql, startTestPostgres, type TestPostgres } from '@platform/testing/postgres';
import { sql } from 'drizzle-orm';
import { ClsModule } from 'nestjs-cls';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { billingMigrations } from './billing.migrations.js';
import { type BillingSchema, billingSchema } from './billing.schema.js';

/*
 * Billing's generated history against a real PostgreSQL 18, through the DatabaseModule wiring
 * billing-service boots: the platform set, then billingMigrations, into the `billing` schema.
 * Opt-in (needs Docker):
 *   INTEGRATION=1 bunx vitest run --project billing:int
 * Always a fresh container (startTestPostgres ignores INTEGRATION_DATABASE_URL by default):
 * Citus 14.2 on PostgreSQL 18, single node (@platform/testing/postgres).
 */

@Module({
  imports: [
    AppConfigModule.forRoot(),
    ClsModule.forRoot({ global: true }),
    DatabaseModule.forRootAsync({
      schema: billingSchema,
      migrations: [billingMigrations],
      runMigrations: true,
    }),
  ],
})
class BillingPersistenceModule {}

/**
 * Boots the wiring above. `abortOnError: false`: a failing boot rejects with its own error, where
 * Nest's default calls process.abort() and kills the Vitest worker before afterAll runs.
 */
const boot = (): Promise<INestApplicationContext> =>
  NestFactory.createApplicationContext(BillingPersistenceModule, {
    logger: false,
    abortOnError: false,
  });

/** Entries in a set's drizzle journal: once applied, its bookkeeping table holds one row each. */
const journalSize = (set: DatabaseMigrationSet): number => {
  const journal = JSON.parse(readFileSync(join(set.folder, 'meta', '_journal.json'), 'utf8')) as {
    entries: unknown[];
  };
  return journal.entries.length;
};

describe.skipIf(process.env['INTEGRATION'] !== '1')('billing migrations on PostgreSQL 18', () => {
  let pg: TestPostgres | undefined;
  let app: INestApplicationContext | undefined;
  let db: DrizzleDB<BillingSchema>;

  /** Bookkeeping rows of the platform set (schema `app`) and of billing's set. */
  const bookkeeping = async (): Promise<{ app: number; billing: number }> => {
    const [counts] = await db.execute<{ app: number; billing: number }>(sql`
      select (select count(*)::int from app.__drizzle_migrations) as app,
        (select count(*)::int from billing.__drizzle_migrations) as billing`);
    return { app: counts?.app ?? -1, billing: counts?.billing ?? -1 };
  };

  beforeAll(async () => {
    // The platform set's 0002 needs the three roles; this spec still migrates as the superuser.
    pg = await startTestPostgres({ initSql: readRolesInitSql() });
    vi.stubEnv('DATABASE_URL', pg.url);
    vi.stubEnv('DATABASE_MIGRATION_URL', pg.url);
    vi.stubEnv('SERVICE_NAME', 'billing-int');
    app = await boot();
    db = app.get(DRIZZLE);
  });

  afterAll(async () => {
    await app?.close();
    await pg?.stop();
    vi.unstubAllEnvs();
  });

  it("creates billing's tables and enum in the billing schema, and none of identity's", async () => {
    const tables = await db.execute<{ name: string }>(sql`
      select table_schema || '.' || table_name as name from information_schema.tables
      where table_schema in ('app', 'billing', 'identity')`);
    expect(tables.map((row) => row.name).toSorted()).toEqual([
      'app.__drizzle_migrations',
      'app.tenant_colocation',
      'billing.__drizzle_migrations',
      'billing.payments',
      'billing.stripe_events',
    ]);
    // billing-service never creates identity's enum: each app applies only its own sets.
    const enums = await db.execute<{ name: string }>(sql`
      select n.nspname || '.' || t.typname as name
      from pg_type t join pg_namespace n on n.oid = t.typnamespace
      where t.typname in ('user_role', 'payment_status') and n.nspname <> 'public'`);
    expect(enums.map((row) => row.name)).toEqual(['billing.payment_status']);
    const [status] = await db.execute<{ labels: string }>(sql`
      select string_agg(e.enumlabel, ',' order by e.enumsortorder) as labels
      from pg_enum e join pg_type t on t.oid = e.enumtypid
      join pg_namespace n on n.oid = t.typnamespace
      where n.nspname = 'billing' and t.typname = 'payment_status'`);
    expect(status?.labels).toBe(
      'pending,succeeded,failed,expired,refunded,partially_refunded,disputed',
    );
  });

  it('puts no table and no payment_status type in public', async () => {
    // The platform set's pg_trgm puts functions, operators and types in public, never tables.
    // Under this spec's role `app`, an unqualified table or enum lands in schema `app` instead
    // (search_path "$user", public), where the first test's lists catch it.
    // Citus adds its views (citus_tables, citus_shards, …) to public: views are not tables.
    const tables = await db.execute<{ name: string }>(sql`
      select table_name as name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'`);
    expect(tables.map((row) => row.name)).toEqual([]);
    const types = await db.execute<{ name: string }>(sql`
      select t.typname as name from pg_type t join pg_namespace n on n.oid = t.typnamespace
      where n.nspname = 'public' and t.typname = 'payment_status'`);
    expect(types.map((row) => row.name)).toEqual([]);
  });

  it("records one bookkeeping row per journal entry, in each set's own table", async () => {
    await expect(bookkeeping()).resolves.toEqual({
      app: journalSize(platformMigrations),
      billing: journalSize(billingMigrations),
    });
  });

  it('carries the tenant-leading keys of 0001 and the purge index', async () => {
    // billing.__drizzle_migrations (the migrator's SERIAL PRIMARY KEY) is not part of the history.
    const indexes = await db.execute<{ indexname: string }>(sql`
      select indexname from pg_indexes
      where schemaname = 'billing' and tablename in ('payments', 'stripe_events')`);
    expect(indexes.map((row) => row.indexname).toSorted()).toEqual([
      'payments_tenant_id_id_pk',
      'payments_tenant_id_stripe_checkout_session_id_uq',
      'payments_tenant_id_user_id_id_idx',
      'payments_tenant_id_user_id_idempotency_key_uq',
      'stripe_events_processed_at_idx',
      'stripe_events_tenant_id_id_pk',
    ]);
  });

  it('the DB defaults (uuidv7 id, pending status) cover raw SQL inserts', async () => {
    const [row] = await db.execute<{ id: string; status: string }>(sql`
      insert into billing.payments (tenant_id, user_id, price_id, quantity)
      values (${generateId()}, ${generateId()}, 'price_int', 1) returning id, status`);
    expect(isUuidV7(row?.id)).toBe(true);
    expect(row?.status).toBe('pending');
  });

  // Last: it replaces the context the tests above share.
  it('a second boot of the same wiring against the same database applies nothing', async () => {
    const before = await bookkeeping();
    // A restart: the first context and its pool are gone before the second one boots.
    const first = app;
    app = undefined; // afterAll then closes only what is open, even if the boot below throws
    await first?.close();
    // Rejects, failing this test, if the restart re-ran a migration (`CREATE TYPE` again).
    app = await boot();
    db = app.get(DRIZZLE);
    await expect(bookkeeping()).resolves.toEqual(before);
  });
});

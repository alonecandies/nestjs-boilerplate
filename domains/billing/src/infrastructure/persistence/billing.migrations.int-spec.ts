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
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
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
 * Set INTEGRATION_DATABASE_URL to use an existing throwaway database instead of testcontainers.
 */

const IMAGE = 'postgres:18.6-alpine3.24';

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
  let container: StartedPostgreSqlContainer | undefined;
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
    let url = process.env['INTEGRATION_DATABASE_URL'];
    if (url === undefined) {
      container = await new PostgreSqlContainer(IMAGE)
        .withDatabase('app')
        .withUsername('app')
        .withPassword('app')
        .start();
      url = container.getConnectionUri();
    }
    vi.stubEnv('DATABASE_URL', url);
    vi.stubEnv('SERVICE_NAME', 'billing-int');
    app = await boot();
    db = app.get(DRIZZLE);
  });

  afterAll(async () => {
    await app?.close();
    await container?.stop();
    vi.unstubAllEnvs();
  });

  it("creates billing's tables and enum in the billing schema, and none of identity's", async () => {
    const tables = await db.execute<{ name: string }>(sql`
      select table_schema || '.' || table_name as name from information_schema.tables
      where table_schema in ('app', 'billing', 'identity')`);
    expect(tables.map((row) => row.name).toSorted()).toEqual([
      'app.__drizzle_migrations',
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
    expect(status?.labels).toBe('pending,succeeded,failed,expired');
  });

  it('puts no table and no payment_status type in public', async () => {
    // The platform set's pg_trgm puts functions, operators and types in public, never tables.
    // Under this spec's role `app`, an unqualified table or enum lands in schema `app` instead
    // (search_path "$user", public), where the first test's lists catch it.
    const tables = await db.execute<{ name: string }>(sql`
      select table_name as name from information_schema.tables where table_schema = 'public'`);
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

  it('carries every index of the former 0000 and 0002 migrations', async () => {
    // billing.__drizzle_migrations (the migrator's SERIAL PRIMARY KEY) is not part of the history.
    const indexes = await db.execute<{ indexname: string }>(sql`
      select indexname from pg_indexes
      where schemaname = 'billing' and tablename in ('payments', 'stripe_events')`);
    expect(indexes.map((row) => row.indexname).toSorted()).toEqual([
      'payments_pkey',
      'payments_stripe_checkout_session_id_unique',
      'payments_user_id_id_idx',
      'payments_user_id_idempotency_key_uq',
      'stripe_events_pkey',
      'stripe_events_processed_at_idx',
    ]);
  });

  it('the DB defaults (uuidv7 id, pending status) cover raw SQL inserts', async () => {
    const [row] = await db.execute<{ id: string; status: string }>(sql`
      insert into billing.payments (user_id, price_id, quantity)
      values (${generateId()}, 'price_int', 1) returning id, status`);
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

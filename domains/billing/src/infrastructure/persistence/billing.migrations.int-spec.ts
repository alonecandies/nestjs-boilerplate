import { type INestApplicationContext, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { generateId, isUuidV7 } from '@platform/common';
import { AppConfigModule } from '@platform/config';
import { DatabaseModule, DRIZZLE, type DrizzleDB } from '@platform/database';
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

describe.skipIf(process.env['INTEGRATION'] !== '1')('billing migrations on PostgreSQL 18', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let app: INestApplicationContext;
  let db: DrizzleDB<BillingSchema>;

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
    app = await NestFactory.createApplicationContext(BillingPersistenceModule, { logger: false });
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
});

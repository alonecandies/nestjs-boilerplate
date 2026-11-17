import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type INestApplicationContext, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  createPrincipal,
  generateId,
  PLATFORM_TENANT_ID,
  runWithPrincipal,
  SystemContext,
} from '@platform/common';
import { AppConfigModule } from '@platform/config';
import { DatabaseModule, DRIZZLE, type DrizzleDB } from '@platform/database';
import { type RlsTestPostgres, startRlsTestPostgres } from '@platform/testing/postgres';
import { sql } from 'drizzle-orm';
import { ClsModule } from 'nestjs-cls';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { makePayment } from '../../../test/billing-test.utils.js';
import { billingMigrations } from './billing.migrations.js';
import { type BillingSchema, billingSchema } from './billing.schema.js';
import { DrizzlePaymentsRepository } from './drizzle-payments.repository.js';
import { DrizzleStripeEventsSystemRepository } from './drizzle-stripe-events.system-repository.js';

/*
 * Billing's distribution migration (sharding design SH-6) on Citus 14.2, single node, local execution
 * off (startRlsTestPostgres): every shard query goes over a remote connection, as on a cluster.
 * The real runner applies the platform set and billing's whole history as app_owner (the migration
 * role), all pending files of a set in one transaction, as on a fresh production database. Data
 * goes through the superuser: under 0003's forced RLS the owner reads and writes no row, and the
 * policies themselves are billing.rls.int-spec.ts's subject. Repository calls still run as a
 * principal (the unit of work refuses to BEGIN without one), and the purge as the system method on
 * app_system, in SystemContext.
 * Opt-in (needs Docker):
 *   INTEGRATION=1 bunx vitest run --project billing:int distribution
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
  providers: [DrizzlePaymentsRepository, DrizzleStripeEventsSystemRepository],
})
class BillingDistributionModule {}

const boot = (): Promise<INestApplicationContext> =>
  NestFactory.createApplicationContext(BillingDistributionModule, {
    logger: false,
    abortOnError: false,
  });

/** The statements of one migration file, split as drizzle splits them. */
const statements = (file: string): string[] =>
  readFileSync(join(billingMigrations.folder, file), 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement !== '');

/** The SQLSTATE a statement fails with (drizzle wraps the driver error as `cause`), or undefined. */
async function sqlState(statement: Promise<unknown>): Promise<string | undefined> {
  try {
    await statement;
    return undefined;
  } catch (error) {
    const { cause, code } = error as { cause?: { code?: string }; code?: string };
    return cause?.code ?? code;
  }
}

describe.skipIf(process.env['INTEGRATION'] !== '1')('billing distribution on Citus', () => {
  let pg: RlsTestPostgres | undefined;
  let app: INestApplicationContext | undefined;
  let db: DrizzleDB<BillingSchema>;

  const use = (context: INestApplicationContext): void => {
    app = context;
    db = context.get(DRIZZLE);
  };

  /**
   * Every Citus table of the two sets: kind, colocation group and shard count. Names are qualified
   * from pg_namespace: `regclass::text` drops the schema that is on the search_path (the
   * superuser's "$user" is `app`).
   */
  const citusTables = async (): Promise<unknown[]> => [
    ...(await db.execute(sql`
      select n.nspname || '.' || c.relname as name, d.partmethod, d.colocationid,
        (select count(*)::int from pg_dist_shard s where s.logicalrelid = d.logicalrelid) as shards
      from pg_dist_partition d
      join pg_class c on c.oid = d.logicalrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('billing', 'app')
      order by 1`)),
  ];

  /** The shard that holds `tenantId`'s rows of billing's tenant tables. */
  const shardOf = async (tenantId: string): Promise<string> => {
    const [row] = await db.execute<{ shard: string }>(sql`
      select get_shard_id_for_distribution_column('billing.stripe_events', ${tenantId}::uuid)::text
        as shard`);
    return row?.shard ?? expect.fail(`no shard for ${tenantId}`);
  };

  beforeAll(async () => {
    pg = await startRlsTestPostgres();
    vi.stubEnv('DATABASE_URL', pg.url);
    vi.stubEnv('DATABASE_MIGRATION_URL', pg.migrationUrl);
    vi.stubEnv('DATABASE_SYSTEM_URL', pg.systemUrl);
    vi.stubEnv('SERVICE_NAME', 'billing-distribution-int');
    use(await boot());
  });

  afterAll(async () => {
    await app?.close();
    await pg?.stop();
    vi.unstubAllEnvs();
  });

  it('migrated as app_owner, with local execution off', async () => {
    const [row] = await db.execute<{ owners: string; local: string }>(sql`
      select (select string_agg(distinct tableowner, ',') from pg_tables
          where schemaname = 'billing' and tablename in ('payments', 'stripe_events')) as owners,
        current_setting('citus.enable_local_execution') as local`);
    expect(row).toEqual({ owners: 'app_owner', local: 'off' });
  });

  it('distributes payments and stripe_events by tenant_id, colocated with app.tenant_colocation', async () => {
    const [kinds] = await db.execute<Record<string, string | null>>(sql`
      select app.citus_table_kind('billing.payments') as payments,
        app.citus_table_kind('billing.stripe_events') as stripe_events,
        app.citus_table_kind('app.tenant_colocation') as anchor`);
    expect(kinds).toEqual({
      payments: 'hash:tenant_id',
      stripe_events: 'hash:tenant_id',
      anchor: 'hash:tenant_id',
    });
    const groups = await db.execute<{ name: string; colocationid: number }>(sql`
      select logicalrelid::text as name, colocationid from pg_dist_partition
      where logicalrelid in ('billing.payments'::regclass, 'billing.stripe_events'::regclass,
        'app.tenant_colocation'::regclass)`);
    expect(groups).toHaveLength(3);
    expect(new Set(groups.map((row) => row.colocationid)).size).toBe(1);
  });

  it('re-applying the distribution file changes nothing', async () => {
    const before = await citusTables();
    // payments, stripe_events and outbox (0004_outbox), and the anchor app.tenant_colocation.
    expect(before).toHaveLength(4);
    for (const statement of statements('0002_distribute.sql')) {
      await db.execute(sql.raw(statement));
    }
    await expect(citusTables()).resolves.toEqual(before);
  });

  it('deleteProcessedBefore removes exactly the old events of three tenants and the platform tenant', async () => {
    // Three tenants on three different shards, none on the platform tenant's: all four shards.
    const platformShard = await shardOf(PLATFORM_TENANT_ID);
    const tenants: string[] = [];
    const shards = new Set([platformShard]);
    for (let attempt = 0; attempt < 500 && tenants.length < 3; attempt += 1) {
      const candidate = generateId();
      const shard = await shardOf(candidate);
      if (shards.has(shard)) continue;
      shards.add(shard);
      tenants.push(candidate);
    }
    expect(shards.size).toBe(4);

    const cutoff = new Date('2026-10-01T00:00:00.000Z');
    const old = new Date('2026-09-01T00:00:00.000Z');
    const fresh = new Date('2026-10-02T00:00:00.000Z');
    const survivors: string[] = [];
    for (const [index, tenantId] of [...tenants, PLATFORM_TENANT_ID].entries()) {
      const userId = tenantId === PLATFORM_TENANT_ID ? null : generateId();
      const rows = [
        { id: `evt_old_a_${index}`, at: old },
        { id: `evt_old_b_${index}`, at: old },
        { id: `evt_at_cutoff_${index}`, at: cutoff },
        { id: `evt_fresh_${index}`, at: fresh },
      ];
      for (const row of rows) {
        await db.execute(sql`
          insert into billing.stripe_events (tenant_id, id, user_id, type, processed_at)
          values (${tenantId}, ${row.id}, ${userId}, 't', ${row.at.toISOString()})`);
      }
      survivors.push(`${tenantId}/evt_at_cutoff_${index}`, `${tenantId}/evt_fresh_${index}`);
    }

    const events = app!.get(DrizzleStripeEventsSystemRepository);
    const purge = (): Promise<number> =>
      SystemContext.run('billing.distribution-int', () => events.deleteProcessedBefore(cutoff));
    await expect(purge()).resolves.toBe(8);

    const left = await db.execute<{ key: string }>(
      sql`select tenant_id || '/' || id as key from billing.stripe_events`,
    );
    expect(left.map((row) => row.key).toSorted()).toEqual(survivors.toSorted());
    await expect(purge()).resolves.toBe(0);
  });

  it('both uniques of payments still reject duplicates within a tenant, not across tenants', async () => {
    const [tenantId, otherTenant, userId] = [generateId(), generateId(), generateId()];
    const insert = (tenant: string, session: string, key: string): Promise<unknown> =>
      db.execute(sql`
        insert into billing.payments
          (tenant_id, user_id, price_id, quantity, stripe_checkout_session_id, idempotency_key)
        values (${tenant}, ${userId}, 'price_int', 1, ${session}, ${key})`);

    await expect(sqlState(insert(tenantId, 'cs_1', 'key-00001'))).resolves.toBeUndefined();
    // (tenant_id, stripe_checkout_session_id)
    await expect(sqlState(insert(tenantId, 'cs_1', 'key-00002'))).resolves.toBe('23505');
    // (tenant_id, user_id, idempotency_key)
    await expect(sqlState(insert(tenantId, 'cs_2', 'key-00001'))).resolves.toBe('23505');
    await expect(sqlState(insert(otherTenant, 'cs_1', 'key-00001'))).resolves.toBeUndefined();
  });

  it('a query by (tenant_id, id) is a router query and returns the row', async () => {
    const payments = app!.get(DrizzlePaymentsRepository);
    const payment = makePayment({ tenantId: generateId() });
    const owner = createPrincipal({ userId: payment.userId, tenantId: payment.tenantId });
    await runWithPrincipal(owner, () => payments.create(payment));

    await expect(
      runWithPrincipal(owner, () => payments.findById(payment.tenantId, payment.id)),
    ).resolves.toMatchObject({
      id: payment.id,
      tenantId: payment.tenantId,
    });
    const plan = await db.execute<{ 'QUERY PLAN': string }>(sql`
      explain (costs off) select * from billing.payments
      where tenant_id = ${payment.tenantId}::uuid and id = ${payment.id}::uuid`);
    const text = plan.map((row) => row['QUERY PLAN']).join('\n');
    expect(text).toContain('Citus Adaptive');
    expect(text).toContain('Task Count: 1');
  });

  // Last: it replaces the context the tests above share.
  it('a second boot applies nothing and keeps the distribution', async () => {
    const applied = async (): Promise<number | undefined> => {
      const [row] = await db.execute<{ count: number }>(
        sql`select count(*)::int as count from billing.__drizzle_migrations`,
      );
      return row?.count;
    };
    const before = await citusTables();
    const files = await applied();
    // 0000_init .. 0004_outbox.
    expect(files).toBe(5);
    const first = app;
    app = undefined; // afterAll then closes only what is open, even if the boot below throws
    await first?.close();
    use(await boot());
    await expect(applied()).resolves.toBe(files);
    await expect(citusTables()).resolves.toEqual(before);
  });
});

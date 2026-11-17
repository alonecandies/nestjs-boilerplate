import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateId, PLATFORM_TENANT_ID } from '@platform/common';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type BillingDatabase, startBillingDatabase } from '../../../test/billing-database.js';
import { makePayment } from '../../../test/billing-test.utils.js';
import { billingMigrations } from './billing.migrations.js';
import { DrizzlePaymentsRepository } from './drizzle-payments.repository.js';
import { DrizzleStripeEventsRepository } from './drizzle-stripe-events.repository.js';

/*
 * Billing repositories against Citus 14.2 (single node, local execution off: tenant isolation) with
 * billing's real history, so both tables are distributed by tenant_id (0002_distribute, SH-6).
 * Opt-in: INTEGRATION=1 npx vitest run --project billing:int repositories
 * Every query carries tenant_id (sharding §2.1.5): a router query to one shard.
 */
const statements = (file: string): string[] =>
  readFileSync(join(billingMigrations.folder, file), 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement !== '');

describe.skipIf(process.env['INTEGRATION'] !== '1')('billing repositories on Citus', () => {
  let database: BillingDatabase | undefined;
  let payments: DrizzlePaymentsRepository;
  let events: DrizzleStripeEventsRepository;
  const tenantA = generateId();
  const tenantB = generateId();
  const user = generateId();

  beforeAll(async () => {
    database = await startBillingDatabase(
      [DrizzlePaymentsRepository, DrizzleStripeEventsRepository],
      {
        localExecution: false,
      },
    );
    payments = database.app.get(DrizzlePaymentsRepository);
    events = database.app.get(DrizzleStripeEventsRepository);
  });

  afterAll(async () => {
    await database?.close();
  });

  it('lists, finds and locks only inside the tenant', async () => {
    const a = makePayment({ tenantId: tenantA, userId: user });
    const b = makePayment({ tenantId: tenantB, userId: user });
    await payments.create(a);
    await payments.create(b);

    const listA = await payments.list({ tenantId: tenantA, limit: 10 });
    expect(listA.items.map((p) => p.id)).toEqual([a.id]);
    await expect(payments.findById(tenantB, a.id)).resolves.toBeNull();
    await expect(payments.findById(tenantA, a.id)).resolves.toMatchObject({ tenantId: tenantA });
    await expect(
      payments.findForCheckoutSession({ tenantId: tenantB, paymentId: a.id, sessionId: 'cs_none' }),
    ).resolves.toBeNull();
  });

  it('dedupes an Idempotency-Key per (tenant, user): the same key in another tenant is a new payment', async () => {
    const first = await payments.create(
      makePayment({ tenantId: tenantA, userId: user, idempotencyKey: 'k-1' }),
    );
    const replay = await payments.create(
      makePayment({ tenantId: tenantA, userId: user, idempotencyKey: 'k-1' }),
    );
    const other = await payments.create(
      makePayment({ tenantId: tenantB, userId: user, idempotencyKey: 'k-1' }),
    );

    expect(first.created).toBe(true);
    expect(replay).toMatchObject({ created: false, payment: { id: first.payment.id } });
    expect(other.created).toBe(true);
  });

  it('records Stripe events per tenant, with a NULL user for platform events', async () => {
    await expect(
      events.markProcessed({ tenantId: tenantA, userId: user, id: 'evt_1', type: 't' }),
    ).resolves.toBe(true);
    await expect(
      events.markProcessed({ tenantId: tenantA, userId: user, id: 'evt_1', type: 't' }),
    ).resolves.toBe(false);
    await expect(
      events.markProcessed({
        tenantId: PLATFORM_TENANT_ID,
        userId: null,
        id: 'evt_payout',
        type: 'payout.paid',
      }),
    ).resolves.toBe(true);
    const rows = await database!.db.execute<{ tenant_id: string; user_id: string | null }>(
      sql`select tenant_id, user_id from billing.stripe_events where id = 'evt_payout'`,
    );
    expect([...rows]).toEqual([{ tenant_id: PLATFORM_TENANT_ID, user_id: null }]);
  });

  describe('0001 on a database that already has payments', () => {
    let legacy: BillingDatabase | undefined;

    beforeAll(async () => {
      legacy = await startBillingDatabase([], { runMigrations: false });
      for (const statement of statements('0000_init.sql'))
        await legacy.db.execute(sql.raw(statement));
      await legacy.db.execute(
        sql.raw(
          `insert into billing.payments (user_id, price_id, quantity) values ('${user}', 'price_old', 1)`,
        ),
      );
      await legacy.db.execute(
        sql.raw(`insert into billing.stripe_events (id, type) values ('evt_old', 'x')`),
      );
      for (const statement of statements('0001_tenant_columns.sql'))
        await legacy.db.execute(sql.raw(statement));
    });

    afterAll(async () => {
      await legacy?.close();
    });

    it('moves pre-tenancy rows to the platform tenant and keeps tenant_id NOT NULL without a default', async () => {
      const rows = await legacy!.db.execute<{ tenant_id: string }>(
        sql`select tenant_id from billing.payments union all select tenant_id from billing.stripe_events`,
      );
      expect([...rows].map((r) => r.tenant_id)).toEqual([PLATFORM_TENANT_ID, PLATFORM_TENANT_ID]);
      // drizzle-orm 0.45 wraps driver errors in DrizzleQueryError ("Failed query: …"); the
      // postgres.js error (SQLSTATE 23502 not_null_violation) is its `cause`.
      await expect(
        legacy!.db.execute(
          sql.raw(
            `insert into billing.payments (user_id, price_id, quantity) values ('${user}', 'p', 1)`,
          ),
        ),
      ).rejects.toMatchObject({
        cause: expect.objectContaining({ code: '23502', column_name: 'tenant_id' }),
      });
    });
  });
});

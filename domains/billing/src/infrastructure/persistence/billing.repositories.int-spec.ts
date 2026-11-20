import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createPrincipal,
  generateId,
  PLATFORM_TENANT_ID,
  runWithPrincipal,
  SystemContext,
} from '@platform/common';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type BillingDatabase, startBillingDatabase } from '../../../test/billing-database.js';
import { makePayment } from '../../../test/billing-test.utils.js';
import { DrizzlePaymentsRepository } from './drizzle-payments.repository.js';
import { DrizzleStripeEventsRepository } from './drizzle-stripe-events.repository.js';
import { DrizzleStripeEventsSystemRepository } from './drizzle-stripe-events.system-repository.js';

/*
 * Billing repositories against Citus 14.2 (single node, local execution off: tenant isolation) with
 * billing's real history, so both tables are distributed by tenant_id (SH-6).
 * Opt-in: INTEGRATION=1 npx vitest run --project billing:int repositories
 * Every query carries tenant_id (sharding §2.1.5): a router query to one shard. The app runs as
 * app_runtime under the forced RLS, so each repository call runs as a principal (the user in
 * the tenant it acts in); platform events go through the system repository in SystemContext.
 * billing.repositories.rls.int-spec.ts covers every method and its refusals.
 */
/** The stacked history from before the SH-12 squash, where 0001's backfill lives. */
const STACKED_FOLDER = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'test',
  'stacked-history',
  'migrations',
);
const statements = (file: string): string[] =>
  readFileSync(join(STACKED_FOLDER, file), 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement !== '');

describe.skipIf(process.env['INTEGRATION'] !== '1')('billing repositories on Citus', () => {
  let database: BillingDatabase | undefined;
  let payments: DrizzlePaymentsRepository;
  let events: DrizzleStripeEventsRepository;
  let system: DrizzleStripeEventsSystemRepository;
  const tenantA = generateId();
  const tenantB = generateId();
  const user = generateId();
  const inA = <T>(work: () => Promise<T>): Promise<T> =>
    runWithPrincipal(createPrincipal({ userId: user, tenantId: tenantA }), work);
  const inB = <T>(work: () => Promise<T>): Promise<T> =>
    runWithPrincipal(createPrincipal({ userId: user, tenantId: tenantB }), work);

  beforeAll(async () => {
    database = await startBillingDatabase(
      [
        DrizzlePaymentsRepository,
        DrizzleStripeEventsRepository,
        DrizzleStripeEventsSystemRepository,
      ],
      {
        localExecution: false,
      },
    );
    payments = database.app.get(DrizzlePaymentsRepository);
    events = database.app.get(DrizzleStripeEventsRepository);
    system = database.app.get(DrizzleStripeEventsSystemRepository);
  });

  afterAll(async () => {
    await database?.close();
  });

  it('lists, finds and locks only inside the tenant', async () => {
    const a = makePayment({ tenantId: tenantA, userId: user });
    const b = makePayment({ tenantId: tenantB, userId: user });
    await inA(() => payments.create(a));
    await inB(() => payments.create(b));

    const listA = await inA(() => payments.list({ tenantId: tenantA, limit: 10 }));
    expect(listA.items.map((p) => p.id)).toEqual([a.id]);
    await expect(inB(() => payments.findById(tenantB, a.id))).resolves.toBeNull();
    await expect(inA(() => payments.findById(tenantA, a.id))).resolves.toMatchObject({
      tenantId: tenantA,
    });
    await expect(
      inB(() =>
        payments.findForCheckoutSession({
          tenantId: tenantB,
          paymentId: a.id,
          sessionId: 'cs_none',
        }),
      ),
    ).resolves.toBeNull();
  });

  it('dedupes an Idempotency-Key per (tenant, user): the same key in another tenant is a new payment', async () => {
    const first = await inA(() =>
      payments.create(makePayment({ tenantId: tenantA, userId: user, idempotencyKey: 'k-1' })),
    );
    const replay = await inA(() =>
      payments.create(makePayment({ tenantId: tenantA, userId: user, idempotencyKey: 'k-1' })),
    );
    const other = await inB(() =>
      payments.create(makePayment({ tenantId: tenantB, userId: user, idempotencyKey: 'k-1' })),
    );

    expect(first.created).toBe(true);
    expect(replay).toMatchObject({ created: false, payment: { id: first.payment.id } });
    expect(other.created).toBe(true);
  });

  it('records Stripe events per tenant, with a NULL user for platform events', async () => {
    await expect(
      inA(() => events.markProcessed({ tenantId: tenantA, userId: user, id: 'evt_1', type: 't' })),
    ).resolves.toBe(true);
    await expect(
      inA(() => events.markProcessed({ tenantId: tenantA, userId: user, id: 'evt_1', type: 't' })),
    ).resolves.toBe(false);
    await expect(
      SystemContext.run('billing.repositories-int', () =>
        system.markProcessedAsPlatform({
          tenantId: PLATFORM_TENANT_ID,
          userId: null,
          id: 'evt_payout',
          type: 'payout.paid',
        }),
      ),
    ).resolves.toBe(true);
    const rows = await database!.superuser.execute<{ tenant_id: string; user_id: string | null }>(
      sql`select tenant_id, user_id from billing.stripe_events where id = 'evt_payout'`,
    );
    expect([...rows]).toEqual([{ tenant_id: PLATFORM_TENANT_ID, user_id: null }]);
  });

  // The stacked 0001's backfill (test/stacked-history: before the squash, kept as the record).
  describe('0001 on a database that already has payments', () => {
    let legacy: BillingDatabase | undefined;

    beforeAll(async () => {
      legacy = await startBillingDatabase([], { runMigrations: false });
      for (const statement of statements('0000_init.sql'))
        await legacy.superuser.execute(sql.raw(statement));
      await legacy.superuser.execute(
        sql.raw(
          `insert into billing.payments (user_id, price_id, quantity) values ('${user}', 'price_old', 1)`,
        ),
      );
      await legacy.superuser.execute(
        sql.raw(`insert into billing.stripe_events (id, type) values ('evt_old', 'x')`),
      );
      for (const statement of statements('0001_tenant_columns.sql'))
        await legacy.superuser.execute(sql.raw(statement));
    });

    afterAll(async () => {
      await legacy?.close();
    });

    it('moves pre-tenancy rows to the platform tenant and keeps tenant_id NOT NULL without a default', async () => {
      const rows = await legacy!.superuser.execute<{ tenant_id: string }>(
        sql`select tenant_id from billing.payments union all select tenant_id from billing.stripe_events`,
      );
      expect([...rows].map((r) => r.tenant_id)).toEqual([PLATFORM_TENANT_ID, PLATFORM_TENANT_ID]);
      // drizzle-orm 0.45 wraps driver errors in DrizzleQueryError ("Failed query: …"); the
      // postgres.js error (SQLSTATE 23502 not_null_violation) is its `cause`.
      await expect(
        legacy!.superuser.execute(
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

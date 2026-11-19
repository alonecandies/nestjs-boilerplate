import {
  LEDGER_POSTING_REQUESTED_EVENT,
  type LedgerPostingRequestedPayload,
} from '@domain/billing-contracts';
import { CommandBus, CqrsModule } from '@nestjs/cqrs';
import { RbacModule } from '@platform/auth';
import { PLATFORM_TENANT_ID, SystemContext } from '@platform/common';
import { createEventEnvelope, type EventEnvelope } from '@platform/contracts';
import { buildRlsContextSql } from '@platform/database';
import { IMMUDB_TEST_IMAGE, ImmudbModule } from '@platform/immudb';
import { sql } from 'drizzle-orm';
import postgres, { type Sql } from 'postgres';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ReconcileLedgerCommand } from '../src/application/commands/reconcile-ledger/reconcile-ledger.command.js';
import type { PostingBalanceTransaction } from '../src/application/ledger/posting-rules.js';
import { LedgerSystemRepository } from '../src/application/repositories/ledger.system-repository.js';
import { BILLING_RBAC } from '../src/billing.permissions.js';
import { BillingMessagingModule } from '../src/billing-messaging.module.js';
import { ledgerEntryId } from '../src/domain/ledger/ledger.ids.js';
import { PaymentStatus } from '../src/domain/payment-status.enum.js';
import { billingLedgerMigrations } from '../src/infrastructure/ledger/billing-ledger.migrations.js';
import { payments as paymentsTable } from '../src/infrastructure/persistence/billing.schema.js';
import { toPaymentRow } from '../src/infrastructure/persistence/payment-row.mapper.js';
import { type LedgerSource, StripeService } from '../src/infrastructure/stripe/stripe.service.js';
import { LedgerPostingConsumer } from '../src/presentation/messaging/ledger-posting.consumer.js';
import { type BillingDatabase, startBillingDatabase } from './billing-database.js';
import { makePayment, TEST_WEBHOOK_SECRET } from './billing-test.utils.js';

/*
 * The hourly reconciliation R1-R3 (outbox plan Task 15, L-13) on Citus 14.2 (local execution off)
 * and immudb 1.11.2: the real BillingMessagingModule with LEDGER_ENABLED=true (its
 * BillingLedgerModule registers ReconcileLedgerCommand and the cron), the ledger seeded through the
 * real posting path (LedgerPostingConsumer → immudb + receipts) for tenants A and B and the
 * platform. Only Stripe is a fake (`ledgerSource`).
 * Opt-in (needs Docker): INTEGRATION=1 bunx vitest run --project billing:int reconcile-ledger
 */

const TENANT_A = '0197c900-0000-7000-8000-0000000000a0';
const TENANT_B = '0197c900-0000-7000-8000-0000000000b0';
const A1 = '0197c900-0000-7000-8000-00000000a001';
const B1 = '0197c900-0000-7000-8000-00000000b001';
const PAY_A = '0197c900-0000-7000-8000-0000000a0001';
const PAY_B = '0197c900-0000-7000-8000-0000000b0001';
const PAY_A_UNPOSTED = '0197c900-0000-7000-8000-0000000a0002';
const PAY_B_WRONG_REF = '0197c900-0000-7000-8000-0000000b0002';
const CREATED = 1_794_182_400;
const HOUR = 3_600_000;

const txn = (overrides: Partial<PostingBalanceTransaction>): PostingBalanceTransaction => ({
  id: 'txn_rc_a',
  amount: 2_500,
  fee: 103,
  currency: 'usd',
  created: CREATED,
  reporting_category: 'charge',
  source: 'ch_rc_a',
  ...overrides,
});

/** What the fake Stripe answers per object id. */
const SOURCES: Readonly<Record<string, LedgerSource>> = {
  ch_rc_a: {
    transactions: [txn({})],
    pending: false,
    presentment: { amount: 2_500n, currency: 'usd' },
  },
  ch_rc_b: {
    transactions: [txn({ id: 'txn_rc_b', source: 'ch_rc_b' })],
    pending: false,
    presentment: { amount: 2_500n, currency: 'usd' },
  },
  po_rc_1: {
    transactions: [
      txn({
        id: 'txn_rc_payout',
        amount: -5_000,
        fee: 0,
        reporting_category: 'payout',
        source: 'po_rc_1',
      }),
    ],
    pending: false,
    presentment: null,
  },
};

const message = (
  payload: Omit<LedgerPostingRequestedPayload, 'source' | 'livemode'>,
  meta: { readonly id: string; readonly actorId: string | null },
): EventEnvelope<LedgerPostingRequestedPayload> =>
  createEventEnvelope(
    LEDGER_POSTING_REQUESTED_EVENT,
    { source: 'stripe', livemode: false, ...payload },
    { ...meta, tenantId: payload.tenantId, source: 'billing' },
  );

const POSTINGS = [
  message(
    {
      stripeEventId: 'evt_rc_charge_a',
      stripeEventType: 'charge.succeeded',
      objectType: 'charge',
      objectId: 'ch_rc_a',
      tenantId: TENANT_A,
      userId: A1,
      paymentId: PAY_A,
    },
    { id: '0197c900-0000-5000-8000-00000000e001', actorId: A1 },
  ),
  message(
    {
      stripeEventId: 'evt_rc_charge_b',
      stripeEventType: 'charge.succeeded',
      objectType: 'charge',
      objectId: 'ch_rc_b',
      tenantId: TENANT_B,
      userId: B1,
      paymentId: PAY_B,
    },
    { id: '0197c900-0000-5000-8000-00000000e002', actorId: B1 },
  ),
  message(
    {
      stripeEventId: 'evt_rc_payout',
      stripeEventType: 'payout.paid',
      objectType: 'payout',
      objectId: 'po_rc_1',
      tenantId: PLATFORM_TENANT_ID,
      userId: null,
      paymentId: null,
    },
    { id: '0197c900-0000-5000-8000-00000000e003', actorId: null },
  ),
];

type DiscrepancyView = {
  tenant_id: string;
  kind: string;
  source_key: string;
  detected_by: string;
  run_id: string | null;
};
type RunView = {
  id: string;
  status: string;
  counts: unknown;
  from_ts: Date;
  to_ts: Date;
  finished_at: Date | null;
};

describe.skipIf(process.env['INTEGRATION'] !== '1')(
  'ReconcileLedgerCommand R1-R3 over Citus and immudb',
  () => {
    let immudb: StartedTestContainer | undefined;
    let database: BillingDatabase | undefined;
    let commands: CommandBus;
    let runtime: Sql;

    const db = () => database ?? expect.fail('no database');
    const reconcile = () =>
      SystemContext.run('billing.reconcile-ledger', () =>
        commands.execute(new ReconcileLedgerCommand()),
      );
    const runs = async (): Promise<RunView[]> => [
      ...(await db().superuser.execute<RunView>(sql`
        select id, status, counts, from_ts, to_ts, finished_at
        from billing.ledger_reconciliation_runs order by created_at, id`)),
    ];
    const discrepancies = async (): Promise<DiscrepancyView[]> => [
      ...(await db().superuser.execute<DiscrepancyView>(sql`
        select tenant_id, kind, source_key, detected_by, run_id
        from billing.ledger_discrepancies order by tenant_id, kind`)),
    ];
    /** The discrepancies a runtime principal reads, elevated or not. */
    const visibleTo = (userId: string, tenantId: string, elevated: boolean) =>
      runtime.begin(async (tx) => {
        await tx.unsafe(buildRlsContextSql({ userId, tenantId })).simple();
        if (elevated) await tx.unsafe(`SET LOCAL app.elevated = 'on'`);
        return [
          ...(await tx<{ tenant_id: string; kind: string }[]>`
            select tenant_id, kind from billing.ledger_discrepancies order by kind`),
        ];
      });
    const seedPayments = async (...rows: { tenantId: string; userId: string; id: string }[]) => {
      const paidAt = new Date(Date.now() - HOUR);
      const succeeded = {
        status: PaymentStatus.Succeeded,
        amountTotal: 2_500,
        currency: 'usd',
        paidAt,
      };
      await db()
        .superuser.insert(paymentsTable)
        .values(rows.map((row) => toPaymentRow(makePayment({ ...row, ...succeeded }))));
    };

    beforeAll(async () => {
      immudb = await new GenericContainer(IMMUDB_TEST_IMAGE)
        .withEnvironment({ IMMUDB_PGSQL_SERVER: 'false' })
        .withExposedPorts(3322, 9497)
        .withWaitStrategy(Wait.forHttp('/readyz', 9497))
        .start();
      vi.stubEnv('IMMUDB_ADDRESS', `${immudb.getHost()}:${immudb.getMappedPort(3322)}`);
      vi.stubEnv('IMMUDB_DATABASE', 'ledger_reconcile_it');
      vi.stubEnv('IMMUDB_ADMIN_PASSWORD', 'immudb');
      vi.stubEnv('IMMUDB_RUN_MIGRATIONS', 'true');
      vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_billing_reconcile_int');
      vi.stubEnv('STRIPE_WEBHOOK_SECRET', TEST_WEBHOOK_SECRET);
      vi.stubEnv('LEDGER_ENABLED', 'true');
      // The fake Stripe; seeding happens here, before the root config restores mocks per test.
      vi.spyOn(StripeService.prototype, 'ledgerSource').mockImplementation(async (_type, id) => {
        const source = SOURCES[id];
        if (source === undefined) throw new Error(`the fake Stripe knows no ${id}`);
        return source;
      });
      database = await startBillingDatabase([], {
        imports: [
          CqrsModule.forRoot(),
          RbacModule.forRoot(),
          RbacModule.forFeature(BILLING_RBAC),
          ImmudbModule.forRootAsync({ migrations: [billingLedgerMigrations] }),
          BillingMessagingModule,
        ],
      });
      commands = database.app.get(CommandBus);
      runtime = postgres(database.pg.runtimeUrl, { max: 1, onnotice: () => undefined });

      await seedPayments(
        { tenantId: TENANT_A, userId: A1, id: PAY_A },
        { tenantId: TENANT_B, userId: B1, id: PAY_B },
      );
      const consumer = database.app.get(LedgerPostingConsumer, { strict: false });
      for (const posting of POSTINGS) await consumer.onLedgerPosting(posting);
    }, 360_000);

    afterAll(async () => {
      await runtime?.end({ timeout: 5 });
      await database?.close();
      await immudb?.stop();
    });

    it('a clean run appends nothing and finishes a ledger_reconciliation_runs row with its counts', async () => {
      // The real posting path left one ref per tenant and the platform's.
      const refTenants = await db().superuser.execute<{ tenant_id: string }>(
        sql`select tenant_id from billing.ledger_entry_refs order by tenant_id`,
      );
      expect([...refTenants].map((r) => r.tenant_id)).toEqual(
        [PLATFORM_TENANT_ID, TENANT_A, TENANT_B].sort(),
      );

      await expect(reconcile()).resolves.toEqual({ found: {}, appended: {} });

      const [run, ...others] = await runs();
      expect(others).toEqual([]);
      expect(run).toMatchObject({ status: 'succeeded', counts: { found: {}, appended: {} } });
      expect(run?.finished_at).not.toBeNull();
      expect(new Date(run?.to_ts ?? 0).getTime() - new Date(run?.from_ts ?? 0).getTime()).toBe(
        72 * HOUR,
      );
      expect(await discrepancies()).toEqual([]);
    });

    it("finds a paid payment without an entry and a ref under the wrong tenant, under the right tenant, readable by that tenant's elevated principal only", async () => {
      await seedPayments(
        { tenantId: TENANT_A, userId: A1, id: PAY_A_UNPOSTED },
        { tenantId: TENANT_B, userId: B1, id: PAY_B_WRONG_REF },
      );
      // B's ref names A's charge entry: the ledger holds no such entry under B.
      const entryA = ledgerEntryId('stripe:txn:txn_rc_a');
      await SystemContext.run('billing.reconcile-ledger', () =>
        db()
          .app.get(LedgerSystemRepository, { strict: false })
          .recordEntryRefs([
            {
              tenantId: TENANT_B,
              entryId: entryA,
              sourceKey: 'stripe:txn:txn_rc_a',
              payloadHash: '0'.repeat(64),
              immudbTxId: null,
              paymentId: PAY_B_WRONG_REF,
              kind: 'charge',
              postedAt: new Date(),
            },
          ]),
      );

      const found = { payment_without_entry: 1, tenant_mismatch: 1 };
      await expect(reconcile()).resolves.toEqual({ found, appended: found });

      const run = (await runs()).at(-1);
      expect(run).toMatchObject({ status: 'succeeded', counts: { found, appended: found } });
      expect(await discrepancies()).toEqual([
        {
          tenant_id: TENANT_A,
          kind: 'payment_without_entry',
          source_key: `payment:${PAY_A_UNPOSTED}`,
          detected_by: 'R3',
          run_id: run?.id,
        },
        {
          tenant_id: TENANT_B,
          kind: 'tenant_mismatch',
          source_key: 'stripe:txn:txn_rc_a',
          detected_by: 'R3',
          run_id: run?.id,
        },
      ]);

      expect(await visibleTo(A1, TENANT_A, true)).toEqual([
        { tenant_id: TENANT_A, kind: 'payment_without_entry' },
      ]);
      expect(await visibleTo(B1, TENANT_B, true)).toEqual([
        { tenant_id: TENANT_B, kind: 'tenant_mismatch' },
      ]);
      expect(await visibleTo(A1, TENANT_A, false)).toEqual([]);
      expect(await visibleTo(B1, TENANT_B, false)).toEqual([]);

      // The overlapping next run finds the same and appends nothing.
      await expect(reconcile()).resolves.toEqual({
        found,
        appended: { payment_without_entry: 0, tenant_mismatch: 0 },
      });
      expect(await discrepancies()).toHaveLength(2);
    });
  },
);

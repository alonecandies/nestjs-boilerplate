import {
  LEDGER_POSTING_REQUESTED_EVENT,
  type LedgerPostingRequestedPayload,
} from '@domain/billing-contracts';
import { Global, Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { RbacModule } from '@platform/auth';
import { PLATFORM_TENANT_ID } from '@platform/common';
import { createEventEnvelope, type EventEnvelope } from '@platform/contracts';
import { buildRlsContextSql } from '@platform/database';
import { IMMUDB_TEST_IMAGE, ImmudbClient, ImmudbModule } from '@platform/immudb';
import { InvalidEventException, KafkaProducer } from '@platform/transport';
import { FakeKafkaProducer } from '@platform/transport/testing';
import { sql } from 'drizzle-orm';
import postgres, { type Sql } from 'postgres';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from 'vitest';
import type { PostingBalanceTransaction } from '../src/application/ledger/posting-rules.js';
import { LedgerPort } from '../src/application/ports/ledger.port.js';
import { BILLING_RBAC } from '../src/billing.permissions.js';
import { BillingMessagingModule } from '../src/billing-messaging.module.js';
import { ledgerAccountId, ledgerEntryId } from '../src/domain/ledger/ledger.ids.js';
import type { LedgerPostOutcome } from '../src/domain/ledger/ledger.types.js';
import { billingLedgerMigrations } from '../src/infrastructure/ledger/billing-ledger.migrations.js';
import { ImmudbLedgerAdapter } from '../src/infrastructure/ledger/immudb-ledger.adapter.js';
import { type LedgerSource, StripeService } from '../src/infrastructure/stripe/stripe.service.js';
import { LedgerPostingConsumer } from '../src/presentation/messaging/ledger-posting.consumer.js';
import { type BillingDatabase, startBillingDatabase } from './billing-database.js';
import { TEST_WEBHOOK_SECRET } from './billing-test.utils.js';

/*
 * The ledger-posting consumer end to end (outbox plan Task 13, L-12) on Citus 14.2 (local execution
 * off) and immudb 1.11.2: the real BillingMessagingModule with LEDGER_ENABLED=true, so LedgerPort
 * is the ImmudbLedgerAdapter over ImmudbModule (provisioned and migrated at boot), the receipts go
 * through the real runtime and system repositories. Only Stripe is a fake (`ledgerSource`).
 * Opt-in (needs Docker): INTEGRATION=1 bunx vitest run --project billing:int ledger-posting
 */

const TENANT_A = '0197c800-0000-7000-8000-0000000000a0';
const TENANT_B = '0197c800-0000-7000-8000-0000000000b0';
const A1 = '0197c800-0000-7000-8000-00000000a001';
const B1 = '0197c800-0000-7000-8000-00000000b001';
const PAYMENT_A = '0197c800-0000-7000-8000-0000000a0001';
const CREATED = 1_794_182_400;

const txn = (overrides: Partial<PostingBalanceTransaction>): PostingBalanceTransaction => ({
  id: 'txn_it_charge_a',
  amount: 2_500,
  fee: 103,
  currency: 'usd',
  created: CREATED,
  reporting_category: 'charge',
  source: 'ch_it_a',
  ...overrides,
});

/** What the fake Stripe answers per object id. */
const SOURCES: Readonly<Record<string, LedgerSource>> = {
  ch_it_a: {
    transactions: [txn({})],
    pending: false,
    presentment: { amount: 2_500n, currency: 'usd' },
  },
  ch_it_b: {
    transactions: [txn({ id: 'txn_it_charge_b', source: 'ch_it_b' })],
    pending: false,
    presentment: { amount: 2_500n, currency: 'usd' },
  },
  po_it_1: {
    transactions: [
      txn({
        id: 'txn_it_payout',
        amount: -10_000,
        fee: 0,
        reporting_category: 'payout',
        source: 'po_it_1',
      }),
    ],
    pending: false,
    presentment: null,
  },
};

const message = (
  payload: LedgerPostingRequestedPayload,
  meta: { readonly id: string; readonly tenantId: string; readonly actorId: string | null },
): EventEnvelope<LedgerPostingRequestedPayload> =>
  createEventEnvelope(LEDGER_POSTING_REQUESTED_EVENT, payload, { ...meta, source: 'billing' });

const chargeA = message(
  {
    source: 'stripe',
    stripeEventId: 'evt_it_charge_a',
    stripeEventType: 'charge.succeeded',
    objectType: 'charge',
    objectId: 'ch_it_a',
    tenantId: TENANT_A,
    userId: A1,
    paymentId: PAYMENT_A,
    livemode: false,
  },
  { id: '0197c800-0000-5000-8000-00000000e001', tenantId: TENANT_A, actorId: A1 },
);

/** The apps' global Kafka producer (reconciliation R4 builds its outbox envelopes with it). */
@Global()
@Module({
  providers: [{ provide: KafkaProducer, useValue: new FakeKafkaProducer({ source: 'billing' }) }],
  exports: [KafkaProducer],
})
class FakeKafkaModule {}

describe.skipIf(process.env['INTEGRATION'] !== '1')(
  'LedgerPostingConsumer posts to immudb and records its receipts (Citus + immudb)',
  () => {
    let immudb: StartedTestContainer | undefined;
    let database: BillingDatabase | undefined;
    let consumer: LedgerPostingConsumer;
    let ledgerSource: MockInstance<StripeService['ledgerSource']>;
    let post: MockInstance<LedgerPort['post']>;
    let client: ImmudbClient;
    let runtime: Sql;
    let system: Sql;

    const db = () => database ?? expect.fail('no database');
    const outcomes = async (): Promise<LedgerPostOutcome[]> =>
      Promise.all(post.mock.results.map((result) => result.value as Promise<LedgerPostOutcome>));
    const entriesOf = (sourceKey: string) =>
      client.readOnly((tx) =>
        tx.query<{ id: string; tenant_id: string }>(
          'SELECT id, tenant_id FROM ledger_entries WHERE source_key = @source_key',
          { source_key: sourceKey },
        ),
      );
    const postingsOf = (entryId: string) =>
      client.readOnly((tx) =>
        tx.query<{ currency: string; debit: bigint; credit: bigint }>(
          'SELECT currency, debit, credit FROM ledger_postings WHERE entry_id = @entry_id',
          { entry_id: entryId },
        ),
      );
    const refs = async () => [
      ...(await db().superuser.execute<{
        tenant_id: string;
        entry_id: string;
        source_key: string;
        immudb_tx_id: string | null;
        payment_id: string | null;
        kind: string;
      }>(sql`select tenant_id, entry_id, source_key, immudb_tx_id, payment_id, kind
        from billing.ledger_entry_refs order by tenant_id, entry_id`)),
    ];
    const accounts = async () => [
      ...(await db().superuser.execute<{ tenant_id: string; code: string; currency: string }>(
        sql`select tenant_id, code, currency, immudb_account_id from billing.ledger_accounts
          order by tenant_id, code`,
      )),
    ];

    beforeAll(async () => {
      immudb = await new GenericContainer(IMMUDB_TEST_IMAGE)
        .withEnvironment({ IMMUDB_PGSQL_SERVER: 'false' })
        .withExposedPorts(3322, 9497)
        .withWaitStrategy(Wait.forHttp('/readyz', 9497))
        .start();
      vi.stubEnv('IMMUDB_ADDRESS', `${immudb.getHost()}:${immudb.getMappedPort(3322)}`);
      vi.stubEnv('IMMUDB_DATABASE', 'ledger_posting_it');
      vi.stubEnv('IMMUDB_ADMIN_PASSWORD', 'immudb');
      vi.stubEnv('IMMUDB_RUN_MIGRATIONS', 'true');
      vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_billing_ledger_posting_int');
      vi.stubEnv('STRIPE_WEBHOOK_SECRET', TEST_WEBHOOK_SECRET);
      vi.stubEnv('LEDGER_ENABLED', 'true');
      // A Stripe GET before the spies of beforeEach exist would reach the network: refuse it.
      vi.spyOn(StripeService.prototype, 'ledgerSource').mockRejectedValue(new Error('no spy yet'));
      database = await startBillingDatabase([], {
        imports: [
          FakeKafkaModule,
          CqrsModule.forRoot(),
          RbacModule.forRoot(),
          RbacModule.forFeature(BILLING_RBAC),
          ImmudbModule.forRootAsync({ migrations: [billingLedgerMigrations] }),
          BillingMessagingModule,
        ],
      });
      consumer = database.app.get(LedgerPostingConsumer, { strict: false });
      client = database.app.get(ImmudbClient, { strict: false });
      expect(database.app.get(LedgerPort, { strict: false })).toBeInstanceOf(ImmudbLedgerAdapter);
      runtime = postgres(database.pg.runtimeUrl, { max: 1, onnotice: () => undefined });
      system = postgres(database.pg.systemUrl, { max: 1, onnotice: () => undefined });
    }, 360_000);

    // The root config restores mocks before each test: (re)create the spies per test.
    beforeEach(() => {
      ledgerSource = vi
        .spyOn(StripeService.prototype, 'ledgerSource')
        .mockImplementation(async (_type, id) => {
          const source = SOURCES[id];
          if (source === undefined) throw new Error(`the fake Stripe knows no ${id}`);
          return source;
        });
      post = vi.spyOn(db().app.get(LedgerPort, { strict: false }), 'post');
    });

    afterAll(async () => {
      await runtime?.end({ timeout: 5 });
      await system?.end({ timeout: 5 });
      await database?.close();
      await immudb?.stop();
    });

    it('a charge for A processed twice concurrently and once more later leaves one balanced entry, one ref and the account rows', async () => {
      await Promise.all([consumer.onLedgerPosting(chargeA), consumer.onLedgerPosting(chargeA)]);
      await consumer.onLedgerPosting(chargeA);

      const entryId = ledgerEntryId('stripe:txn:txn_it_charge_a');
      const results = await outcomes();
      expect(results.map((o) => o.status).sort()).toEqual(['posted', 'replayed', 'replayed']);
      const posted = results.find((o) => o.status === 'posted');
      if (posted?.status !== 'posted') throw new Error('nothing was posted');

      expect(await entriesOf('stripe:txn:txn_it_charge_a')).toEqual([
        { id: entryId, tenant_id: TENANT_A },
      ]);
      const postings = await postingsOf(entryId);
      expect(postings).toHaveLength(4);
      const sum = (key: 'debit' | 'credit') => postings.reduce((n, p) => n + p[key], 0n);
      expect(sum('debit')).toBe(sum('credit'));
      expect(sum('debit')).toBe(2_603n);

      const [ref, ...others] = await refs();
      expect(others).toEqual([]);
      expect(ref).toMatchObject({
        tenant_id: TENANT_A,
        entry_id: entryId,
        source_key: 'stripe:txn:txn_it_charge_a',
        payment_id: PAYMENT_A,
        kind: 'charge',
      });
      expect([null, String(posted.immudbTxId)]).toContain(ref?.immudb_tx_id ?? null);

      expect(await accounts()).toEqual([
        {
          tenant_id: PLATFORM_TENANT_ID,
          code: 'asset:stripe_balance',
          currency: 'usd',
          immudb_account_id: ledgerAccountId(PLATFORM_TENANT_ID, 'asset:stripe_balance', 'usd'),
        },
        {
          tenant_id: PLATFORM_TENANT_ID,
          code: 'expense:stripe_fees',
          currency: 'usd',
          immudb_account_id: ledgerAccountId(PLATFORM_TENANT_ID, 'expense:stripe_fees', 'usd'),
        },
        {
          tenant_id: TENANT_A,
          code: 'revenue:checkout',
          currency: 'usd',
          immudb_account_id: ledgerAccountId(TENANT_A, 'revenue:checkout', 'usd'),
        },
      ]);
    });

    it("a message whose payload names tenant B inside A's envelope posts nothing", async () => {
      const forged = message(
        {
          ...chargeA.payload,
          stripeEventId: 'evt_it_forged',
          objectId: 'ch_it_b',
          tenantId: TENANT_B,
          userId: B1,
        },
        { id: '0197c800-0000-5000-8000-00000000e002', tenantId: TENANT_A, actorId: A1 },
      );
      const refsBefore = await refs();

      await expect(consumer.onLedgerPosting(forged)).rejects.toBeInstanceOf(InvalidEventException);

      expect(ledgerSource).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
      expect(await entriesOf('stripe:txn:txn_it_charge_b')).toEqual([]);
      expect(await refs()).toEqual(refsBefore);
    });

    it('a payout posts on the platform tenant; its Postgres rows are readable by the system pool only', async () => {
      const payout = message(
        {
          source: 'stripe',
          stripeEventId: 'evt_it_payout',
          stripeEventType: 'payout.paid',
          objectType: 'payout',
          objectId: 'po_it_1',
          tenantId: PLATFORM_TENANT_ID,
          userId: null,
          paymentId: null,
          livemode: false,
        },
        { id: '0197c800-0000-5000-8000-00000000e003', tenantId: PLATFORM_TENANT_ID, actorId: null },
      );

      await consumer.onLedgerPosting(payout);

      const entryId = ledgerEntryId('stripe:txn:txn_it_payout');
      expect(await entriesOf('stripe:txn:txn_it_payout')).toEqual([
        { id: entryId, tenant_id: PLATFORM_TENANT_ID },
      ]);
      expect((await refs()).filter((r) => r.entry_id === entryId)).toEqual([
        expect.objectContaining({ tenant_id: PLATFORM_TENANT_ID, kind: 'payout' }),
      ]);
      expect((await accounts()).map((a) => [a.tenant_id, a.code])).toContainEqual([
        PLATFORM_TENANT_ID,
        'asset:bank',
      ]);

      const asSystem = await system`select entry_id from billing.ledger_entry_refs
        where tenant_id = ${PLATFORM_TENANT_ID} and entry_id = ${entryId}`;
      expect([...asSystem]).toEqual([{ entry_id: entryId }]);
      const asSystemAccounts = await system`select code from billing.ledger_accounts
        where tenant_id = ${PLATFORM_TENANT_ID} and code = 'asset:bank'`;
      expect([...asSystemAccounts]).toEqual([{ code: 'asset:bank' }]);

      for (const elevated of [false, true]) {
        const seen = await runtime.begin(async (tx) => {
          await tx.unsafe(buildRlsContextSql({ userId: A1, tenantId: TENANT_A })).simple();
          if (elevated) await tx.unsafe(`SET LOCAL app.elevated = 'on'`);
          return [
            ...(await tx`select entry_id from billing.ledger_entry_refs
              where tenant_id = ${PLATFORM_TENANT_ID}`),
            ...(await tx`select code from billing.ledger_accounts
              where tenant_id = ${PLATFORM_TENANT_ID}`),
          ];
        });
        expect(seen).toEqual([]);
      }
    });
  },
);

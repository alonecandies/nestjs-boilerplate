import { LEDGER_POSTING_REQUESTED_EVENT } from '@domain/billing-contracts';
import { PLATFORM_TENANT_ID, SystemContext } from '@platform/common';
import { parseEventEnvelope } from '@platform/contracts';
import type Stripe from 'stripe';
import { v5 as uuidv5 } from 'uuid';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LEDGER_TEST_TENANT as TENANT_A } from '../../../../../test/ledger-fixtures.js';
import { ledgerEntryId } from '../../../../domain/ledger/ledger.ids.js';
import { LEDGER_NAMESPACE } from '../../../../domain/ledger/ledger.types.js';
import type { LedgerDiscrepancyInput } from '../../../../domain/ledger/ledger-discrepancy.js';
import { PaymentStatus } from '../../../../domain/payment-status.enum.js';
import type { StripeService } from '../../../../infrastructure/stripe/stripe.service.js';
import { InMemoryLedger } from '../../../../testing/in-memory-ledger.js';
import { InMemoryLedgerStore } from '../../../../testing/in-memory-ledger-store.js';
import { postingOwnerOf } from '../../../ledger/ledger-posting-request.js';
import { draftFromBalanceTransaction } from '../../../ledger/posting-rules.js';
import { StripeOwnerResolver } from '../../../ledger/stripe-owner-resolver.js';
import type { LedgerEntryRef } from '../../../repositories/ledger-receipts.repository.js';
import { R4_REF_PAGE_SIZE, R4StripeCheck } from './r4-stripe.js';

const TENANT_B = '0192f0c1-0000-7000-8000-000000000002';
const USER_A = '0192f0c1-0000-7000-8000-00000000a001';
const PAYMENT_A = '0192f0c1-0000-7000-8000-0000000000aa';
const RUN_ID = '0197d000-0000-7000-8000-000000000004';
const NEXT_RUN_ID = '0197d000-0000-7000-8000-000000000005';
const NOW = new Date('2026-11-19T12:00:00.000Z');
const FROM = new Date('2026-11-16T11:45:00.000Z');
const TO = new Date('2026-11-19T11:45:00.000Z');
const CREATED = Math.floor(new Date('2026-11-19T10:00:00.000Z').getTime() / 1000);
const ctx = { runId: RUN_ID, from: FROM, to: TO };

const asSystem = <T>(fn: () => Promise<T>) => SystemContext.run('billing.reconcile-ledger', fn);

/** A charge of tenant A's (signed metadata on the charge itself: no Stripe call to resolve). */
const chargeOfA = {
  id: 'ch_a',
  object: 'charge',
  metadata: { tenantId: TENANT_A, userId: USER_A, paymentId: PAYMENT_A },
};

/** A Stripe balance transaction: a 25.00 USD charge of tenant A with a 1.03 USD fee. */
const bt = (id: string, overrides: Partial<Stripe.BalanceTransaction> = {}) =>
  ({
    id,
    object: 'balance_transaction',
    amount: 2_500,
    fee: 103,
    net: 2_397,
    currency: 'usd',
    created: CREATED,
    reporting_category: 'charge',
    source: chargeOfA,
    status: 'available',
    type: 'charge',
    ...overrides,
  }) as unknown as Stripe.BalanceTransaction;

/**
 * Stripe listing `pages` one page at a time (a page is fetched only when the previous one is
 * consumed, like the SDK's auto-pagination); `fail` throws after the last page instead of ending.
 */
class FakeStripe {
  readonly livemode = false;
  pages: Stripe.BalanceTransaction[][] = [];
  pagesRead = 0;
  windows: { from: Date; to: Date }[] = [];
  fail: Error | null = null;
  readonly retrievePaymentIntent = vi.fn(
    async (_id: string): Promise<Stripe.PaymentIntent | null> => null,
  );

  listBalanceTransactions(window: {
    from: Date;
    to: Date;
  }): AsyncIterable<Stripe.BalanceTransaction> {
    this.windows.push(window);
    const pages = this.pages;
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        for (const page of pages) {
          self.pagesRead += 1;
          yield* page;
        }
        if (self.fail !== null) throw self.fail;
      },
    };
  }
}

describe('R4StripeCheck (reconciliation R4: Stripe balance transactions against the ledger)', () => {
  let ledger: InMemoryLedger;
  let store: InMemoryLedgerStore;
  let stripe: FakeStripe;
  let check: R4StripeCheck;

  const run = (context = ctx) => asSystem(() => check.run(context));
  const append = (rows: readonly LedgerDiscrepancyInput[]) =>
    asSystem(() => store.system.appendDiscrepancies(rows));
  const records = () => store.outbox.records;
  const finding = (
    row: Pick<LedgerDiscrepancyInput, 'tenantId' | 'kind' | 'sourceKey' | 'expected' | 'actual'>,
    runId = RUN_ID,
  ): LedgerDiscrepancyInput => ({ ...row, detectedBy: 'R4', runId });

  /**
   * Posts the entry of `txn` as the consumer does (posting rules, then the ref) under `tenantId`,
   * from `posted` (default: `txn` itself) so a test can store an entry that differs from Stripe.
   */
  const post = async (
    txn: Stripe.BalanceTransaction,
    options: {
      readonly tenantId?: string;
      readonly posted?: Stripe.BalanceTransaction;
      readonly refTenant?: string;
      readonly postedAt?: Date;
    } = {},
  ): Promise<LedgerEntryRef> => {
    const draft = draftFromBalanceTransaction(options.posted ?? txn, {
      tenantId: options.tenantId ?? TENANT_A,
      paymentId: null,
      presentment: { amount: 2_500n, currency: 'usd' },
    });
    if (draft === null) throw new Error('the fixture posts nothing');
    const outcome = await ledger.post(draft);
    const ref: LedgerEntryRef = {
      tenantId: options.refTenant ?? draft.tenantId,
      entryId: outcome.entryId,
      sourceKey: draft.sourceKey,
      payloadHash: outcome.payloadHash,
      immudbTxId: outcome.status === 'posted' ? outcome.immudbTxId : null,
      paymentId: null,
      kind: draft.kind,
      postedAt: options.postedAt ?? new Date(CREATED * 1000 + 2_000),
    };
    store.insertEntryRef(ref);
    return ref;
  };

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    ledger = new InMemoryLedger();
    store = new InMemoryLedgerStore();
    stripe = new FakeStripe();
    check = new R4StripeCheck(
      ledger,
      store.system,
      stripe as unknown as StripeService,
      new StripeOwnerResolver(stripe as unknown as StripeService),
      store.outbox,
    );
    return () => vi.useRealTimers();
  });

  it('is R4, lists Stripe over the run window and the refs from its start until now', async () => {
    const listRefs = vi.spyOn(store.system, 'listEntryRefs');

    await expect(run()).resolves.toEqual([]);

    expect(check.name).toBe('R4');
    expect(stripe.windows).toEqual([{ from: FROM, to: TO }]);
    expect(listRefs).toHaveBeenCalledWith(FROM, NOW, null, R4_REF_PAGE_SIZE);
    expect(R4_REF_PAGE_SIZE).toBe(500);
  });

  it('finds nothing when every balance transaction has its equal entry, and asks Stripe nothing more', async () => {
    const charge = bt('txn_charge');
    const refund = bt('txn_refund', {
      amount: -1_000,
      fee: 0,
      net: -1_000,
      reporting_category: 'refund',
      source: { id: 're_b', object: 'refund' } as never,
    });
    const dispute = bt('txn_dispute', {
      amount: -2_500,
      fee: 1_500,
      net: -4_000,
      reporting_category: 'dispute',
    });
    const payout = bt('txn_payout', {
      amount: -5_000,
      fee: 0,
      net: -5_000,
      reporting_category: 'payout',
      source: { id: 'po_1', object: 'payout' } as never,
    });
    const stripeFee = bt('txn_fee', {
      amount: -500,
      fee: 0,
      net: -500,
      reporting_category: 'fee',
      source: null,
    });
    const nothingMoves = bt('txn_zero', { amount: 0, fee: 0, net: 0 });
    await post(charge);
    await post(refund, { tenantId: TENANT_B });
    await post(dispute);
    await post(payout);
    await post(stripeFee);
    stripe.pages = [[charge, refund, dispute, payout, stripeFee, nothingMoves]];

    await expect(run()).resolves.toEqual([]);

    expect(records()).toEqual([]);
    expect(stripe.retrievePaymentIntent).not.toHaveBeenCalled();
  });

  /** Tenant A's payment `PAYMENT_A` of `userId` (default: its owner, `USER_A`). */
  const seedPaymentOfA = (userId = USER_A) =>
    store.addPayments({
      tenantId: TENANT_A,
      id: PAYMENT_A,
      userId,
      status: PaymentStatus.Succeeded,
      amountTotal: 2_500n,
      currency: 'usd',
      paidAt: new Date(CREATED * 1000),
    });

  /** The payload of the one record R4 enqueued. */
  const enqueuedPayload = () =>
    parseEventEnvelope(LEDGER_POSTING_REQUESTED_EVENT, records()[0]?.envelope).payload;

  it('a transaction without an entry: one missing_entry and one outbox record with the stated payload, envelope id and key', async () => {
    seedPaymentOfA();
    stripe.pages = [[bt('txn_lost')]];

    const found = await run();

    const entryId = ledgerEntryId('stripe:txn:txn_lost');
    expect(found).toEqual([
      finding({
        tenantId: TENANT_A,
        kind: 'missing_entry',
        sourceKey: 'stripe:txn:txn_lost',
        expected: { entryId, kind: 'charge', net: '2397', fee: '103', currency: 'usd' },
        actual: { entryId: null },
      }),
    ]);
    expect(records()).toHaveLength(1);
    const [record] = records();
    const envelopeId = uuidv5(`reconcile:${RUN_ID}:txn_lost`, LEDGER_NAMESPACE);
    expect(record).toMatchObject({
      tenantId: TENANT_A,
      id: envelopeId,
      topic: 'billing.ledger-posting.v1',
      key: TENANT_A,
      publishedAt: null,
    });
    const envelope = parseEventEnvelope(LEDGER_POSTING_REQUESTED_EVENT, record?.envelope);
    expect(envelope).toMatchObject({
      id: envelopeId,
      type: 'billing.ledger-posting.v1',
      tenantId: TENANT_A,
      actorId: USER_A,
      occurredAt: new Date(CREATED * 1000).toISOString(),
    });
    expect(envelope.payload).toEqual({
      source: 'stripe',
      stripeEventId: `reconcile:${RUN_ID}`,
      stripeEventType: 'reconcile.missing_entry',
      objectType: 'balance_transaction',
      objectId: 'txn_lost',
      tenantId: TENANT_A,
      userId: USER_A,
      paymentId: PAYMENT_A,
      livemode: false,
    });
  });

  it.each([
    ['of another user of the tenant', () => seedPaymentOfA('0192f0c1-0000-7000-8000-00000000b001')],
    ['that does not exist', () => undefined],
    [
      'of another tenant',
      () =>
        store.addPayments({
          tenantId: TENANT_B,
          id: PAYMENT_A,
          userId: USER_A,
          status: PaymentStatus.Succeeded,
          amountTotal: 2_500n,
          currency: 'usd',
          paidAt: new Date(CREATED * 1000),
        }),
    ],
  ])(
    'a signed paymentId %s is not named: paymentId null, like the webhook',
    async (_label, seed) => {
      seed();
      stripe.pages = [[bt('txn_lost')]];

      await run();

      expect(enqueuedPayload()).toMatchObject({
        tenantId: TENANT_A,
        userId: USER_A,
        paymentId: null,
      });
      // The webhook path builds the same posting owner for the same lookup result.
      expect(
        postingOwnerOf({ tenantId: TENANT_A, userId: USER_A, paymentId: PAYMENT_A }, null),
      ).toEqual({ tenantId: TENANT_A, userId: USER_A, paymentId: null });
    },
  );

  it("the owner's own payment is named", async () => {
    seedPaymentOfA();
    stripe.pages = [[bt('txn_lost')]];

    await run();

    expect(enqueuedPayload()).toMatchObject({ paymentId: PAYMENT_A });
  });

  it('a ref whose entry the ledger does not return under its tenant is a missing entry too', async () => {
    const txn = bt('txn_ref_only');
    // The entry is B's in the ledger, but the only ref names A: getEntry(A, id) finds nothing.
    await post(txn, { tenantId: TENANT_B, refTenant: TENANT_A });
    stripe.pages = [[txn]];

    const found = await run();

    expect(found.map((row) => [row.kind, row.tenantId])).toEqual([['missing_entry', TENANT_A]]);
    expect(records()).toHaveLength(1);
  });

  it('rerunning the same run id adds no outbox row and no discrepancy row', async () => {
    stripe.pages = [[bt('txn_lost')]];

    const first = await run();
    const second = await run();

    expect(second).toEqual(first);
    expect(records()).toHaveLength(1);
    await expect(append(first)).resolves.toBe(1);
    await expect(append(second)).resolves.toBe(0);
  });

  it('the next run, while the entry is still missing, enqueues a record with a new id and appends no new discrepancy row', async () => {
    stripe.pages = [[bt('txn_lost')]];

    const first = await run();
    await expect(append(first)).resolves.toBe(1);
    const next = await run({ ...ctx, runId: NEXT_RUN_ID });

    expect(records().map((row) => row.id)).toEqual([
      uuidv5(`reconcile:${RUN_ID}:txn_lost`, LEDGER_NAMESPACE),
      uuidv5(`reconcile:${NEXT_RUN_ID}:txn_lost`, LEDGER_NAMESPACE),
    ]);
    expect(next).toEqual(first.map((row) => ({ ...row, runId: NEXT_RUN_ID })));
    await expect(append(next)).resolves.toBe(0);
    expect(store.discrepancies).toHaveLength(1);
  });

  it('an equal entry posted during the grace period is found', async () => {
    const txn = bt('txn_late');
    await post(txn, { postedAt: new Date(TO.getTime() + 60_000) });
    stripe.pages = [[txn]];

    await expect(run()).resolves.toEqual([]);
    expect(records()).toEqual([]);
  });

  it('an equal entry under another tenant than the resolver now returns is found, without asking the resolver', async () => {
    const txn = bt('txn_moved');
    await post(txn, { tenantId: TENANT_B });
    const resolve = vi.spyOn(StripeOwnerResolver.prototype, 'resolve');
    stripe.pages = [[txn]];

    await expect(run()).resolves.toEqual([]);
    expect(resolve).not.toHaveBeenCalled();
    expect(records()).toEqual([]);
  });

  it('a net off by 1 minor unit, another fee or another currency is stripe_amount_mismatch under the ref tenant', async () => {
    const offByOne = bt('txn_net');
    await post(offByOne, {
      tenantId: TENANT_B,
      posted: bt('txn_net', { amount: 2_501, net: 2_398 }),
    });
    const otherFee = bt('txn_fee_diff');
    await post(otherFee, { posted: bt('txn_fee_diff', { fee: 50, net: 2_450 }) });
    const otherCurrency = bt('txn_cur');
    await post(otherCurrency, { posted: bt('txn_cur', { currency: 'eur' }) });
    stripe.pages = [[offByOne, otherFee, otherCurrency]];

    const found = await run();

    const expected = (id: string) => ({
      entryId: ledgerEntryId(`stripe:txn:${id}`),
      net: '2397',
      fee: '103',
      currency: 'usd',
    });
    expect(found).toEqual([
      finding({
        tenantId: TENANT_B,
        kind: 'stripe_amount_mismatch',
        sourceKey: 'stripe:txn:txn_net',
        expected: expected('txn_net'),
        actual: { net: '2398', fee: '103', currency: 'usd' },
      }),
      finding({
        tenantId: TENANT_A,
        kind: 'stripe_amount_mismatch',
        sourceKey: 'stripe:txn:txn_fee_diff',
        expected: expected('txn_fee_diff'),
        actual: { net: '2450', fee: '50', currency: 'usd' },
      }),
      finding({
        tenantId: TENANT_A,
        kind: 'stripe_amount_mismatch',
        sourceKey: 'stripe:txn:txn_cur',
        expected: expected('txn_cur'),
        actual: { net: '0', fee: '0', currency: 'eur' },
      }),
    ]);
    expect(records()).toEqual([]);
  });

  it('a refund whose PaymentIntent has no metadata lands on the platform tenant with tenant_unresolved', async () => {
    stripe.retrievePaymentIntent.mockResolvedValue({
      id: 'pi_1',
      object: 'payment_intent',
      metadata: {},
    } as unknown as Stripe.PaymentIntent);
    const refund = bt('txn_refund_lost', {
      amount: -1_000,
      fee: 0,
      net: -1_000,
      reporting_category: 'refund',
      source: { id: 're_1', object: 'refund', metadata: {}, payment_intent: 'pi_1' } as never,
    });
    stripe.pages = [[refund]];

    const found = await run();

    expect(stripe.retrievePaymentIntent).toHaveBeenCalledExactlyOnceWith('pi_1');
    expect(found).toEqual([
      finding({
        tenantId: PLATFORM_TENANT_ID,
        kind: 'missing_entry',
        sourceKey: 'stripe:txn:txn_refund_lost',
        expected: {
          entryId: ledgerEntryId('stripe:txn:txn_refund_lost'),
          kind: 'refund',
          net: '-1000',
          fee: '0',
          currency: 'usd',
        },
        actual: { entryId: null },
      }),
      finding({
        tenantId: PLATFORM_TENANT_ID,
        kind: 'tenant_unresolved',
        sourceKey: 'stripe:txn:txn_refund_lost',
        expected: { owner: 'tenant' },
        actual: { tenantId: PLATFORM_TENANT_ID, source: 're_1' },
      }),
    ]);
    const [record] = records();
    expect(record).toMatchObject({ tenantId: PLATFORM_TENANT_ID, key: PLATFORM_TENANT_ID });
    expect(parseEventEnvelope(LEDGER_POSTING_REQUESTED_EVENT, record?.envelope)).toMatchObject({
      tenantId: PLATFORM_TENANT_ID,
      actorId: null,
      payload: { tenantId: PLATFORM_TENANT_ID, userId: null, paymentId: null },
    });
  });

  it('a missing platform-level transaction goes to the platform tenant without asking the resolver', async () => {
    const resolve = vi.spyOn(StripeOwnerResolver.prototype, 'resolve');
    stripe.pages = [
      [
        bt('txn_payout_lost', {
          amount: -5_000,
          fee: 0,
          net: -5_000,
          reporting_category: 'payout',
          source: { id: 'po_1', object: 'payout' } as never,
        }),
      ],
    ];

    const found = await run();

    expect(resolve).not.toHaveBeenCalled();
    expect(found.map((row) => [row.kind, row.tenantId])).toEqual([
      ['missing_entry', PLATFORM_TENANT_ID],
    ]);
    expect(records().map((row) => row.tenantId)).toEqual([PLATFORM_TENANT_ID]);
  });

  it('reads three Stripe pages and every page of refs to the end', async () => {
    const present = bt('txn_present');
    const ref = await post(present);
    // 600 other refs before and after it in key order: two pages of refs.
    for (let i = 0; i < 600; i += 1) {
      store.insertEntryRef({ ...ref, entryId: ledgerEntryId(`stripe:txn:txn_other_${i}`) });
    }
    const listRefs = vi.spyOn(store.system, 'listEntryRefs');
    stripe.pages = [[bt('txn_p1')], [present, bt('txn_p2')], [bt('txn_p3')]];

    const found = await run();

    expect(stripe.pagesRead).toBe(3);
    expect(listRefs).toHaveBeenCalledTimes(2);
    expect(found.map((row) => row.sourceKey)).toEqual([
      'stripe:txn:txn_p1',
      'stripe:txn:txn_p2',
      'stripe:txn:txn_p3',
    ]);
    expect(records()).toHaveLength(3);
  });

  it('a Stripe error fails the check and keeps what was already enqueued', async () => {
    stripe.pages = [[bt('txn_before_error')]];
    stripe.fail = new Error('stripe is down');

    await expect(run()).rejects.toThrow('stripe is down');

    expect(records().map((row) => row.envelope.payload)).toEqual([
      expect.objectContaining({ objectId: 'txn_before_error' }),
    ]);
  });

  it('refuses outside SystemContext before asking Stripe', async () => {
    stripe.pages = [[bt('txn_lost')]];

    await expect(check.run(ctx)).rejects.toMatchObject({ code: 'SYSTEM_CONTEXT_REQUIRED' });
    expect(stripe.windows).toEqual([]);
    expect(records()).toEqual([]);
  });
});

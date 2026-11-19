import type { LedgerPostingRequestedPayload } from '@domain/billing-contracts';
import type { CommandBus } from '@nestjs/cqrs';
import {
  createPrincipal,
  PLATFORM_TENANT_ID,
  runWithPrincipal,
  SystemContext,
} from '@platform/common';
import { register } from 'prom-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installTestTransactionHost,
  type TestTransactions,
} from '../../../../test/billing-test.utils.js';
import { LEDGER_TEST_TENANT as TENANT_A } from '../../../../test/ledger-fixtures.js';
import { ledgerEntryId } from '../../../domain/ledger/ledger.ids.js';
import { LEDGER_DISCREPANCIES_TOTAL } from '../../../infrastructure/ledger/ledger-metrics.js';
import type { LedgerSource, StripeService } from '../../../infrastructure/stripe/stripe.service.js';
import { InMemoryLedger } from '../../../testing/in-memory-ledger.js';
import { InMemoryLedgerStore } from '../../../testing/in-memory-ledger-store.js';
import { LedgerService } from '../../ledger/ledger.service.js';
import type { PostingBalanceTransaction } from '../../ledger/posting-rules.js';
import { PostLedgerEntryCommand } from '../post-ledger-entry/post-ledger-entry.command.js';
import { PostLedgerEntryHandler } from '../post-ledger-entry/post-ledger-entry.handler.js';
import { ProcessLedgerPostingCommand } from './process-ledger-posting.command.js';
import {
  LEDGER_SOURCE_ATTEMPTS,
  ProcessLedgerPostingHandler,
} from './process-ledger-posting.handler.js';

const USER_A1 = '0192f0c1-0000-7000-8000-00000000a001';
const PAYMENT = '0192f0c1-0000-7000-8000-0000000000aa';
const CREATED = 1_794_182_400;
const asA = <T>(fn: () => Promise<T>) =>
  runWithPrincipal(createPrincipal({ userId: USER_A1, tenantId: TENANT_A, roles: [] }), fn);
const asSystem = <T>(fn: () => Promise<T>) => SystemContext.run('billing.ledger-posting', fn);

const request = (
  overrides: Partial<LedgerPostingRequestedPayload> = {},
): LedgerPostingRequestedPayload => ({
  source: 'stripe',
  stripeEventId: 'evt_1',
  stripeEventType: 'charge.succeeded',
  objectType: 'charge',
  objectId: 'ch_1',
  tenantId: TENANT_A,
  userId: USER_A1,
  paymentId: PAYMENT,
  livemode: false,
  ...overrides,
});

const txn = (overrides: Partial<PostingBalanceTransaction>): PostingBalanceTransaction => ({
  id: 'txn_1',
  amount: 2_500,
  fee: 103,
  currency: 'usd',
  created: CREATED,
  reporting_category: 'charge',
  source: 'ch_1',
  ...overrides,
});

const counted = async (name: string, labels: Record<string, string>) => {
  const metric = register.getSingleMetric(name);
  const values = metric === undefined ? [] : (await metric.get()).values;
  return (
    values.find((s) => Object.entries(labels).every(([k, v]) => s.labels[k] === v))?.value ?? 0
  );
};

describe('ProcessLedgerPostingHandler', () => {
  let ledger: InMemoryLedger;
  let store: InMemoryLedgerStore;
  let tx: TestTransactions;
  let ledgerSource: ReturnType<typeof vi.fn<StripeService['ledgerSource']>>;
  let posted: PostLedgerEntryCommand[];
  let handler: ProcessLedgerPostingHandler;
  /** At each ledgerSource call: whether a unit of work was open and how many posts had begun. */
  let atSourceCall: { txActive: boolean; posts: number }[];

  const execute = (payload: LedgerPostingRequestedPayload) =>
    handler.execute(new ProcessLedgerPostingCommand(payload));
  const source = (value: Partial<LedgerSource>): LedgerSource => ({
    transactions: [],
    pending: false,
    presentment: null,
    ...value,
  });

  beforeEach(() => {
    register.resetMetrics();
    ledger = new InMemoryLedger();
    store = new InMemoryLedgerStore();
    tx = installTestTransactionHost();
    posted = [];
    atSourceCall = [];
    const postHandler = new PostLedgerEntryHandler(
      new LedgerService(ledger),
      store.receipts,
      store.system,
    );
    const commandBus = {
      execute: (command: unknown) => {
        if (!(command instanceof PostLedgerEntryCommand)) throw new Error('unexpected command');
        posted.push(command);
        return postHandler.execute(command);
      },
    } as unknown as CommandBus;
    ledgerSource = vi.fn<StripeService['ledgerSource']>();
    const stripe = {
      ledgerSource: (...args: Parameters<StripeService['ledgerSource']>) => {
        atSourceCall.push({ txActive: tx.active, posts: posted.length });
        return ledgerSource(...args);
      },
    } as unknown as StripeService;
    handler = new ProcessLedgerPostingHandler(commandBus, stripe, store.receipts, store.system);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("a charge yields one draft of the payload's tenant with the charge's presentment", async () => {
    ledgerSource.mockResolvedValue(
      source({ transactions: [txn({})], presentment: { amount: 2_600n, currency: 'eur' } }),
    );

    await asA(() => execute(request()));

    expect(ledgerSource).toHaveBeenCalledWith('charge', 'ch_1');
    expect(posted.map((c) => c.draft)).toEqual([
      expect.objectContaining({
        sourceKey: 'stripe:txn:txn_1',
        tenantId: TENANT_A,
        kind: 'charge',
        paymentId: PAYMENT,
        stripeObjectId: 'ch_1',
        presentment: { amount: 2_600n, currency: 'eur' },
        occurredAt: new Date(CREATED * 1_000),
      }),
    ]);
    expect(store.entryRefs).toEqual([
      expect.objectContaining({ tenantId: TENANT_A, entryId: ledgerEntryId('stripe:txn:txn_1') }),
    ]);
  });

  it('a dispute with two balance transactions yields two entries', async () => {
    ledgerSource.mockResolvedValue(
      source({
        transactions: [
          txn({
            id: 'txn_d1',
            reporting_category: 'dispute',
            amount: -2_500,
            fee: 1_500,
            source: 'du_1',
          }),
          txn({
            id: 'txn_d2',
            reporting_category: 'dispute_reversal',
            amount: 2_500,
            fee: 0,
            source: 'du_1',
          }),
        ],
        presentment: { amount: 2_500n, currency: 'usd' },
      }),
    );

    await asA(() =>
      execute(
        request({
          objectType: 'dispute',
          objectId: 'du_1',
          stripeEventType: 'charge.dispute.funds_withdrawn',
        }),
      ),
    );

    expect(posted.map((c) => [c.draft.sourceKey, c.draft.kind, c.draft.tenantId])).toEqual([
      ['stripe:txn:txn_d1', 'dispute', TENANT_A],
      ['stripe:txn:txn_d2', 'dispute_reversal', TENANT_A],
    ]);
    expect(store.entryRefs.map((r) => r.sourceKey)).toEqual([
      'stripe:txn:txn_d1',
      'stripe:txn:txn_d2',
    ]);
  });

  it('a payout yields a platform draft (SystemContext)', async () => {
    ledgerSource.mockResolvedValue(
      source({
        transactions: [
          txn({
            id: 'txn_po',
            reporting_category: 'payout',
            amount: -10_000,
            fee: 0,
            source: 'po_1',
          }),
        ],
      }),
    );

    await asSystem(() =>
      execute(
        request({
          stripeEventType: 'payout.paid',
          objectType: 'payout',
          objectId: 'po_1',
          tenantId: PLATFORM_TENANT_ID,
          userId: null,
          paymentId: null,
        }),
      ),
    );

    expect(posted.map((c) => c.draft)).toEqual([
      expect.objectContaining({
        tenantId: PLATFORM_TENANT_ID,
        kind: 'payout',
        paymentId: null,
        presentment: null,
      }),
    ]);
    expect(store.entryRefs).toEqual([expect.objectContaining({ tenantId: PLATFORM_TENANT_ID })]);
  });

  it('pending three times appends fee_unavailable once and resolves (also on a redelivery)', async () => {
    vi.useFakeTimers();
    ledgerSource.mockResolvedValue(source({ pending: true }));

    const run = asA(() => execute(request()));
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(run).resolves.toBeUndefined();

    expect(LEDGER_SOURCE_ATTEMPTS).toBe(3);
    expect(ledgerSource).toHaveBeenCalledTimes(3);
    expect(posted).toEqual([]);
    expect(store.discrepancies).toEqual([
      expect.objectContaining({
        tenantId: TENANT_A,
        kind: 'fee_unavailable',
        sourceKey: 'stripe:charge:ch_1',
        detectedBy: 'consumer',
        runId: null,
      }),
    ]);
    expect(await counted(LEDGER_DISCREPANCIES_TOTAL, { kind: 'fee_unavailable' })).toBe(1);

    const again = asA(() => execute(request()));
    await vi.advanceTimersByTimeAsync(10_000);
    await again;
    expect(store.discrepancies).toHaveLength(1);
  });

  it('waits 1 s and then 2 s between the attempts while Stripe is pending', async () => {
    vi.useFakeTimers();
    ledgerSource
      .mockResolvedValueOnce(source({ pending: true }))
      .mockResolvedValueOnce(source({ pending: true }))
      .mockResolvedValueOnce(source({ transactions: [txn({})] }));

    const run = asA(() => execute(request()));
    await vi.advanceTimersByTimeAsync(0);
    expect(ledgerSource).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(ledgerSource).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(ledgerSource).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(ledgerSource).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await run;

    expect(ledgerSource).toHaveBeenCalledTimes(3);
    expect(posted).toHaveLength(1);
    expect(store.discrepancies).toEqual([]);
  });

  it('a platform pending source appends its finding through the system pool', async () => {
    vi.useFakeTimers();
    ledgerSource.mockResolvedValue(source({ pending: true }));
    const appendDiscrepancy = vi.spyOn(store.receipts, 'appendDiscrepancy');

    const run = asSystem(() =>
      execute(
        request({
          objectType: 'payout',
          objectId: 'po_1',
          tenantId: PLATFORM_TENANT_ID,
          userId: null,
          paymentId: null,
        }),
      ),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await run;

    expect(appendDiscrepancy).not.toHaveBeenCalled();
    expect(store.discrepancies).toEqual([
      expect.objectContaining({ tenantId: PLATFORM_TENANT_ID, kind: 'fee_unavailable' }),
    ]);
  });

  it('a null draft (no money moves) posts nothing', async () => {
    ledgerSource.mockResolvedValue(source({ transactions: [txn({ amount: 0, fee: 0 })] }));

    await asA(() => execute(request()));

    expect(posted).toEqual([]);
    expect(store.entryRefs).toEqual([]);
    expect(store.discrepancies).toEqual([]);
  });

  it('no unit of work is open during ledgerSource, and it runs before any post', async () => {
    ledgerSource.mockResolvedValue(source({ transactions: [txn({}), txn({ id: 'txn_2' })] }));

    await asA(() => execute(request()));

    expect(atSourceCall).toEqual([{ txActive: false, posts: 0 }]);
    expect(posted).toHaveLength(2);
  });

  it('a Stripe failure propagates before anything is posted or recorded', async () => {
    const failure = new Error('stripe down');
    ledgerSource.mockRejectedValue(failure);

    await expect(asA(() => execute(request()))).rejects.toBe(failure);
    expect(posted).toEqual([]);
    expect(store.discrepancies).toEqual([]);
  });
});

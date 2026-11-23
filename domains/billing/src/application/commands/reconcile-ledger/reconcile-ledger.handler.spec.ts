import { Logger } from '@nestjs/common';
import { PLATFORM_TENANT_ID, SystemContext } from '@platform/common';
import { register } from 'prom-client';
import type Stripe from 'stripe';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHARGE_DRAFT, LEDGER_TEST_TENANT as TENANT_A } from '../../../../test/ledger-fixtures.js';
import { LEDGER_RECONCILE_GRACE_MS } from '../../../billing.constants.js';
import type { LedgerEntryDraft } from '../../../domain/ledger/ledger.types.js';
import { PaymentStatus } from '../../../domain/payment-status.enum.js';
import type { LedgerConfig } from '../../../infrastructure/ledger/ledger.config.js';
import {
  LEDGER_DISCREPANCIES_TOTAL,
  LEDGER_RECONCILIATION_LAST_SUCCESS,
  LEDGER_RECONCILIATION_RUNS_TOTAL,
} from '../../../infrastructure/ledger/ledger-metrics.js';
import type { StripeService } from '../../../infrastructure/stripe/stripe.service.js';
import { InMemoryLedger } from '../../../testing/in-memory-ledger.js';
import { InMemoryLedgerStore } from '../../../testing/in-memory-ledger-store.js';
import { StripeOwnerResolver } from '../../ledger/stripe-owner-resolver.js';
import { R1InvariantCheck } from './checks/r1-invariant.js';
import { R2MutationCheck } from './checks/r2-mutation.js';
import { R3PaymentsCheck } from './checks/r3-payments.js';
import { R4StripeCheck } from './checks/r4-stripe.js';
import { R5VerificationCheck } from './checks/r5-verification.js';
import { ReconcileLedgerCommand } from './reconcile-ledger.command.js';
import { ReconcileLedgerHandler } from './reconcile-ledger.handler.js';

const HOUR = 3_600_000;
const MINUTE = 60_000;
const NOW = new Date('2026-11-19T12:00:00.000Z');
const PAYMENT_ID = '0197d400-0000-7000-8000-000000000001';
const config: LedgerConfig = {
  enabled: true,
  reconcileLookbackHours: 72,
  verify: false,
  allowUnverified: false,
};
const asSystem = <T>(fn: () => Promise<T>) => SystemContext.run('billing.reconcile-ledger', fn);

/** One USD entry off by 1 minor unit (R1: one unbalanced_entry and one unbalanced_currency). */
const OFF_BY_ONE: LedgerEntryDraft = {
  ...CHARGE_DRAFT,
  sourceKey: 'stripe:txn:txn_handler_off_by_one',
  lines: CHARGE_DRAFT.lines.map((l, i) => (i === 0 ? { ...l, debit: l.debit + 1n } : l)),
};

/** A payout Stripe lists that the ledger has no entry for (R4: one missing_entry). */
const LOST_PAYOUT = {
  id: 'txn_handler_lost',
  object: 'balance_transaction',
  amount: -5_000,
  fee: 0,
  net: -5_000,
  currency: 'usd',
  created: Math.floor(NOW.getTime() / 1_000) - 7_200,
  reporting_category: 'payout',
  source: { id: 'po_handler', object: 'payout' },
} as unknown as Stripe.BalanceTransaction;

type Sample = { labels: Record<string, string>; value: number };
const metric = async (name: string, labels: Record<string, string> = {}) => {
  const found = register.getSingleMetric(name);
  const values = found === undefined ? [] : ((await found.get()).values as Sample[]);
  return (
    values.find((s) => Object.entries(labels).every(([k, v]) => s.labels[k] === v))?.value ?? 0
  );
};

describe('ReconcileLedgerHandler', () => {
  let ledger: InMemoryLedger;
  let store: InMemoryLedgerStore;
  let r1: R1InvariantCheck;
  let r2: R2MutationCheck;
  let r3: R3PaymentsCheck;
  let r4: R4StripeCheck;
  /** What the fake Stripe lists for R4 (nothing by default). */
  let balanceTransactions: Stripe.BalanceTransaction[];
  let handler: ReconcileLedgerHandler;

  const reconcile = (window?: { from: Date; to: Date }) =>
    asSystem(() => handler.execute(new ReconcileLedgerCommand(window)));
  const onlyRun = () => {
    expect(store.runs.size).toBe(1);
    return [...store.runs.values()][0];
  };
  /** A dirty ledger: one unbalanced entry (R1, two kinds) and one paid payment without entry (R3). */
  const dirty = () => {
    ledger.forge(OFF_BY_ONE);
    store.addPayments({
      tenantId: TENANT_A,
      id: PAYMENT_ID,
      userId: '0197d400-0000-7000-8000-00000000a001',
      status: PaymentStatus.Succeeded,
      amountTotal: 2_500n,
      currency: 'usd',
      paidAt: new Date(NOW.getTime() - 2 * HOUR),
    });
  };

  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    register.resetMetrics();
    // Entries are recorded inside the default window.
    ledger = new InMemoryLedger(() => new Date(NOW.getTime() - 3 * HOUR));
    store = new InMemoryLedgerStore();
    r1 = new R1InvariantCheck(ledger);
    r2 = new R2MutationCheck(ledger);
    r3 = new R3PaymentsCheck(ledger, store.system);
    balanceTransactions = [];
    const stripe = {
      livemode: false,
      async *listBalanceTransactions() {
        yield* balanceTransactions;
      },
      retrievePaymentIntent: async () => null,
    } as unknown as StripeService;
    r4 = new R4StripeCheck(
      ledger,
      store.system,
      stripe,
      new StripeOwnerResolver(stripe),
      store.outbox,
    );
    handler = new ReconcileLedgerHandler(
      config,
      store.system,
      r1,
      r2,
      r3,
      r4,
      new R5VerificationCheck(ledger, store.system),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs R1, R2, R3, R4 in order (R5 only with LEDGER_VERIFY=true)', () => {
    expect(handler.checks.map((check) => check.name)).toEqual(['R1', 'R2', 'R3', 'R4']);
  });

  it("appends R4's missing_entry with its detector and run id and keeps R4's outbox record", async () => {
    balanceTransactions = [LOST_PAYOUT];

    await expect(reconcile()).resolves.toEqual({
      found: { missing_entry: 1 },
      appended: { missing_entry: 1 },
    });

    const runId = onlyRun()?.id;
    expect(onlyRun()?.status).toBe('succeeded');
    expect(store.discrepancies.map((d) => [d.kind, d.detectedBy, d.runId, d.tenantId])).toEqual([
      ['missing_entry', 'R4', runId, PLATFORM_TENANT_ID],
    ]);
    expect(store.outbox.records.map((row) => row.tenantId)).toEqual([PLATFORM_TENANT_ID]);
  });

  it('a clean ledger gives a succeeded run with zero counts over the default window', async () => {
    await ledger.post(CHARGE_DRAFT);

    await expect(reconcile()).resolves.toEqual({ found: {}, appended: {} });

    const run = onlyRun();
    const to = new Date(NOW.getTime() - LEDGER_RECONCILE_GRACE_MS);
    expect(run).toMatchObject({
      status: 'succeeded',
      counts: { found: {}, appended: {} },
      from: new Date(to.getTime() - 72 * HOUR),
      to,
      finishedAt: NOW,
    });
    expect(LEDGER_RECONCILE_GRACE_MS).toBe(900_000);
    expect(store.discrepancies).toEqual([]);
  });

  it('an explicit window wins over the default one', async () => {
    const window = {
      from: new Date('2026-10-01T00:00:00.000Z'),
      to: new Date('2026-10-02T00:00:00.000Z'),
    };
    const spy = vi.spyOn(r2, 'run');

    await reconcile(window);

    expect(onlyRun()).toMatchObject(window);
    expect(spy).toHaveBeenCalledWith({
      runId: onlyRun()?.id,
      ...window,
      entryRefs: expect.any(Function),
    });
  });

  it('builds one context per run and hands the same one to every check', async () => {
    const r2Run = vi.spyOn(r2, 'run');
    const r4Run = vi.spyOn(r4, 'run');

    await reconcile();

    expect(r4Run.mock.calls[0]?.[0]).toBe(r2Run.mock.calls[0]?.[0]);
  });

  it('reads the refs from 24 h before the window once per run; R4 lists only the top-up from the grace period before that read', async () => {
    const listRefs = vi.spyOn(store.system, 'listEntryRefs');
    const r3Run = r3.run.bind(r3);
    vi.spyOn(r3, 'run').mockImplementation(async (ctx) => {
      const found = await r3Run(ctx);
      vi.setSystemTime(new Date(NOW.getTime() + MINUTE));
      return found;
    });

    await expect(reconcile()).resolves.toEqual({ found: {}, appended: {} });

    const from = new Date(NOW.getTime() - LEDGER_RECONCILE_GRACE_MS - 72 * HOUR);
    expect(listRefs.mock.calls).toEqual([
      [new Date(from.getTime() - 24 * HOUR), NOW, null, 500],
      [
        new Date(NOW.getTime() - LEDGER_RECONCILE_GRACE_MS),
        new Date(NOW.getTime() + MINUTE),
        null,
        500,
      ],
    ]);
  });

  it('a failing first ref read fails R3 only: R4 reads again and its findings are appended', async () => {
    balanceTransactions = [LOST_PAYOUT];
    const listRefs = vi
      .spyOn(store.system, 'listEntryRefs')
      .mockRejectedValueOnce(new Error('statement timeout'));
    const r3Run = vi.spyOn(r3, 'run');

    const counts = await reconcile();

    await expect(r3Run.mock.results[0]?.value).rejects.toThrow('statement timeout');
    expect(listRefs).toHaveBeenCalledTimes(2);
    expect(counts).toEqual({ found: { missing_entry: 1 }, appended: { missing_entry: 1 } });
    expect(onlyRun()).toMatchObject({ status: 'failed', counts });
    expect(store.discrepancies.map((d) => [d.kind, d.detectedBy])).toEqual([
      ['missing_entry', 'R4'],
    ]);
  });

  it('refuses an empty or inverted window', () => {
    const at = new Date('2026-10-01T00:00:00.000Z');
    expect(() => new ReconcileLedgerCommand({ from: at, to: at })).toThrow(RangeError);
  });

  it('the same dirty window twice gives equal found and appends nothing the second time', async () => {
    dirty();

    const first = await reconcile();
    const second = await reconcile();

    const found = { unbalanced_entry: 1, unbalanced_currency: 1, payment_without_entry: 1 };
    expect(first).toEqual({ found, appended: found });
    expect(second).toEqual({
      found,
      appended: { unbalanced_entry: 0, unbalanced_currency: 0, payment_without_entry: 0 },
    });
    expect(store.discrepancies).toHaveLength(3);
    expect([...store.runs.values()].map((run) => [run.status, run.counts])).toEqual([
      ['succeeded', first],
      ['succeeded', second],
    ]);
  });

  it('every finding carries its detector and the run id', async () => {
    dirty();

    await reconcile();

    const runId = onlyRun()?.id;
    expect(store.discrepancies.map((d) => [d.kind, d.detectedBy, d.runId, d.tenantId])).toEqual(
      expect.arrayContaining([
        ['unbalanced_entry', 'R1', runId, TENANT_A],
        ['unbalanced_currency', 'R1', runId, PLATFORM_TENANT_ID],
        ['payment_without_entry', 'R3', runId, TENANT_A],
      ]),
    );
  });

  it("with R2 throwing, R3 still runs, the run is failed and R1's rows stay", async () => {
    dirty();
    vi.spyOn(r2, 'run').mockRejectedValue(new Error('immudb history unavailable'));
    const r3Run = vi.spyOn(r3, 'run');

    const counts = await reconcile();

    expect(r3Run).toHaveBeenCalledTimes(1);
    expect(onlyRun()).toMatchObject({ status: 'failed', counts });
    expect(store.discrepancies.map((d) => d.kind).sort()).toEqual([
      'payment_without_entry',
      'unbalanced_currency',
      'unbalanced_entry',
    ]);
    expect(await metric(LEDGER_RECONCILIATION_RUNS_TOTAL, { status: 'failed' })).toBe(1);
    expect(await metric(LEDGER_RECONCILIATION_RUNS_TOTAL, { status: 'succeeded' })).toBe(0);
    expect(await metric(LEDGER_RECONCILIATION_LAST_SUCCESS)).toBe(0);
  });

  it('a check whose findings cannot be appended fails the run, and the next checks still run', async () => {
    dirty();
    const append = store.system.appendDiscrepancies.bind(store.system);
    vi.spyOn(store.system, 'appendDiscrepancies').mockImplementation(async (rows) => {
      if (rows.some((row) => row.detectedBy === 'R1')) throw new Error('postgres down');
      return append(rows);
    });

    await reconcile();

    expect(onlyRun()?.status).toBe('failed');
    expect(store.discrepancies.map((d) => d.kind)).toEqual(['payment_without_entry']);
  });

  it('outside SystemContext the command rejects with SYSTEM_CONTEXT_REQUIRED and starts no run', async () => {
    await expect(handler.execute(new ReconcileLedgerCommand())).rejects.toMatchObject({
      code: 'SYSTEM_CONTEXT_REQUIRED',
    });
    expect(store.runs.size).toBe(0);
  });

  it('moves the run counter, the last-success timestamp and the new-row counter per kind', async () => {
    dirty();

    await reconcile();
    await reconcile();

    expect(await metric(LEDGER_RECONCILIATION_RUNS_TOTAL, { status: 'succeeded' })).toBe(2);
    expect(await metric(LEDGER_RECONCILIATION_RUNS_TOTAL, { status: 'failed' })).toBe(0);
    expect(await metric(LEDGER_RECONCILIATION_LAST_SUCCESS)).toBe(NOW.getTime() / 1_000);
    // New rows only: the second run appended none.
    for (const kind of ['unbalanced_entry', 'unbalanced_currency', 'payment_without_entry']) {
      expect(await metric(LEDGER_DISCREPANCIES_TOTAL, { kind })).toBe(1);
    }
  });
});

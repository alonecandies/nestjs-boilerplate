import { PLATFORM_TENANT_ID, SystemContext } from '@platform/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makePayment } from '../../../../../test/billing-test.utils.js';
import { LEDGER_TEST_TENANT as TENANT_A } from '../../../../../test/ledger-fixtures.js';
import type {
  LedgerEntryDraft,
  LedgerEntryKind,
  LedgerLine,
} from '../../../../domain/ledger/ledger.types.js';
import type { LedgerDiscrepancyInput } from '../../../../domain/ledger/ledger-discrepancy.js';
import { PaymentStatus } from '../../../../domain/payment-status.enum.js';
import { InMemoryLedger } from '../../../../testing/in-memory-ledger.js';
import { InMemoryLedgerStore } from '../../../../testing/in-memory-ledger-store.js';
import type { PaidPaymentRow } from '../../../repositories/ledger.system-repository.js';
import type { LedgerEntryRef } from '../../../repositories/ledger-receipts.repository.js';
import { R3_PAGE_SIZE, R3PaymentsCheck } from './r3-payments.js';

const TENANT_B = '0192f0c1-0000-7000-8000-000000000002';
const USER = '0192f0c1-0000-7000-8000-00000000a001';
const RUN_ID = '0197d000-0000-7000-8000-000000000003';
const MINUTE = 60_000;
const NOW = new Date('2026-11-19T12:00:00.000Z');
const FROM = new Date('2026-11-16T11:45:00.000Z');
const TO = new Date('2026-11-19T11:45:00.000Z');
const PAID = new Date('2026-11-19T10:00:00.000Z');
const ctx = { runId: RUN_ID, from: FROM, to: TO };

let sequence = 0;
const nextId = (prefix: string) =>
  `${prefix}-0000-7000-8000-${(++sequence).toString(16).padStart(12, '0')}`;

const asSystem = <T>(fn: () => Promise<T>) => SystemContext.run('billing.reconcile-ledger', fn);

describe('R3PaymentsCheck (reconciliation R3: billing payments against the ledger refs)', () => {
  let ledger: InMemoryLedger;
  let store: InMemoryLedgerStore;
  let check: R3PaymentsCheck;

  const run = () => asSystem(() => check.run(ctx));

  /** A paid payment (2 500 USD, succeeded, paid inside the window) seeded for the system list. */
  const payment = (tenantId: string, overrides: Partial<PaidPaymentRow> = {}): PaidPaymentRow => {
    const row: PaidPaymentRow = {
      tenantId,
      id: nextId('0197d300'),
      userId: USER,
      status: PaymentStatus.Succeeded,
      amountTotal: 2_500n,
      currency: 'usd',
      paidAt: PAID,
      ...overrides,
    };
    store.addPayments(row);
    return row;
  };

  /**
   * Posts one entry of `kind` and records its ref (as the posting consumer does). `refTenant` is
   * the ref's tenant (default: the payment's), `entryTenant` the entry's in the ledger.
   */
  const posted = async (
    kind: LedgerEntryKind,
    pay: { readonly tenantId: string; readonly id: string } | null,
    options: {
      readonly refTenant?: string;
      readonly entryTenant?: string;
      readonly paymentId?: string | null;
      readonly presentment?: LedgerEntryDraft['presentment'];
      readonly postedAt?: Date;
    } = {},
  ): Promise<LedgerEntryRef> => {
    const refTenant = options.refTenant ?? pay?.tenantId ?? TENANT_A;
    const entryTenant = options.entryTenant ?? refTenant;
    const paymentId = options.paymentId === undefined ? (pay?.id ?? null) : options.paymentId;
    const line = (account: LedgerLine['account'], debit: bigint, credit: bigint): LedgerLine => ({
      account,
      accountOwnerTenantId: account === 'revenue:checkout' ? entryTenant : PLATFORM_TENANT_ID,
      currency: 'usd',
      debit,
      credit,
    });
    const draft: LedgerEntryDraft = {
      sourceKey: `stripe:txn:${nextId('txn')}`,
      tenantId: entryTenant,
      kind,
      paymentId,
      stripeObjectId: null,
      presentment:
        options.presentment === undefined
          ? { amount: 2_500n, currency: 'usd' }
          : options.presentment,
      occurredAt: PAID,
      lines: [line('asset:stripe_balance', 2_500n, 0n), line('revenue:checkout', 0n, 2_500n)],
    };
    const outcome = await ledger.post(draft);
    const ref: LedgerEntryRef = {
      tenantId: refTenant,
      entryId: outcome.entryId,
      sourceKey: draft.sourceKey,
      payloadHash: outcome.payloadHash,
      immudbTxId: outcome.status === 'posted' ? outcome.immudbTxId : null,
      paymentId,
      kind,
      postedAt: options.postedAt ?? new Date(PAID.getTime() + 2_000),
    };
    store.insertEntryRef(ref);
    return ref;
  };

  const finding = (
    row: Pick<LedgerDiscrepancyInput, 'tenantId' | 'kind' | 'sourceKey' | 'expected' | 'actual'>,
  ): LedgerDiscrepancyInput => ({ ...row, detectedBy: 'R3', runId: RUN_ID });

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    ledger = new InMemoryLedger();
    store = new InMemoryLedgerStore();
    check = new R3PaymentsCheck(ledger, store.system);
    return () => vi.useRealTimers();
  });

  it('is R3 and reads pages of 500', () => {
    expect(check.name).toBe('R3');
    expect(R3_PAGE_SIZE).toBe(500);
  });

  it('finds nothing when every paid payment has its charge entry and its status matches the refs', async () => {
    const paid = payment(TENANT_A);
    await posted('charge', paid);
    const refunded = payment(TENANT_B, { status: PaymentStatus.Refunded });
    await posted('charge', refunded);
    await posted('refund', refunded);
    const partly = payment(TENANT_A, { status: PaymentStatus.PartiallyRefunded });
    await posted('charge', partly);
    await posted('refund', partly);
    await posted('refund', partly);
    await posted('refund_failure', partly);
    const disputed = payment(TENANT_B, { status: PaymentStatus.Disputed });
    await posted('charge', disputed);
    await posted('dispute', disputed);
    const reinstated = payment(TENANT_A);
    await posted('charge', reinstated);
    await posted('dispute', reinstated);
    await posted('dispute_reversal', reinstated);
    const refundFailed = payment(TENANT_A);
    await posted('charge', refundFailed);
    await posted('refund', refundFailed);
    await posted('refund_failure', refundFailed);
    // A platform payout has no payment: R3 does not look at it.
    await posted('payout', null, { refTenant: PLATFORM_TENANT_ID, presentment: null });

    await expect(run()).resolves.toEqual([]);
  });

  it('payment_without_entry: a paid payment of the window without a charge ref', async () => {
    const paid = payment(TENANT_A);
    // A refund ref is not the charge entry.
    const refunded = payment(TENANT_B, { status: PaymentStatus.Refunded });
    await posted('refund', refunded);

    const found = await run();

    expect(found).toHaveLength(2);
    expect(found).toEqual(
      expect.arrayContaining([
        finding({
          tenantId: TENANT_A,
          kind: 'payment_without_entry',
          sourceKey: `payment:${paid.id}`,
          expected: { kind: 'charge', paymentId: paid.id },
          actual: { entries: 0 },
        }),
        finding({
          tenantId: TENANT_B,
          kind: 'payment_without_entry',
          sourceKey: `payment:${refunded.id}`,
          expected: { kind: 'charge', paymentId: refunded.id },
          actual: { entries: 0 },
        }),
      ]),
    );
  });

  it('entry_without_payment: a charge ref of the window with no payment id, or one that is not listed', async () => {
    const orphan = await posted('charge', null, { refTenant: TENANT_A });
    const unknownId = nextId('0197d3ff');
    const unknown = await posted('charge', { tenantId: TENANT_B, id: unknownId });
    // A payment that is not paid (still pending) is not listed either.
    const pending = payment(TENANT_A, { status: PaymentStatus.Pending });
    const unpaid = await posted('charge', pending);

    const found = await run();

    expect(found).toHaveLength(3);
    expect(found).toEqual(
      expect.arrayContaining([
        finding({
          tenantId: TENANT_A,
          kind: 'entry_without_payment',
          sourceKey: orphan.sourceKey,
          expected: { paymentId: null },
          actual: { payment: null },
        }),
        finding({
          tenantId: TENANT_B,
          kind: 'entry_without_payment',
          sourceKey: unknown.sourceKey,
          expected: { paymentId: unknownId },
          actual: { payment: null },
        }),
        finding({
          tenantId: TENANT_A,
          kind: 'entry_without_payment',
          sourceKey: unpaid.sourceKey,
          expected: { paymentId: pending.id },
          actual: { payment: null },
        }),
      ]),
    );
  });

  it('entry_without_payment: a charge ref of another tenant than its payment does not pair', async () => {
    const paid = payment(TENANT_A);
    const wrong = await posted('charge', paid, { refTenant: TENANT_B, entryTenant: TENANT_B });

    const found = await run();

    expect(found.map((f) => [f.kind, f.tenantId, f.sourceKey]).sort()).toEqual(
      [
        ['entry_without_payment', TENANT_B, wrong.sourceKey],
        ['payment_without_entry', TENANT_A, `payment:${paid.id}`],
      ].sort(),
    );
  });

  it('amount_mismatch: the entry presentment differs from the payment in amount or currency', async () => {
    const cheaper = payment(TENANT_A);
    const cheaperRef = await posted('charge', cheaper, {
      presentment: { amount: 2_400n, currency: 'usd' },
    });
    const euros = payment(TENANT_B);
    const eurosRef = await posted('charge', euros, {
      presentment: { amount: 2_500n, currency: 'eur' },
    });
    const none = payment(TENANT_A);
    const noneRef = await posted('charge', none, { presentment: null });

    const found = await run();

    expect(found).toHaveLength(3);
    expect(found).toEqual(
      expect.arrayContaining([
        finding({
          tenantId: TENANT_A,
          kind: 'amount_mismatch',
          sourceKey: cheaperRef.sourceKey,
          expected: { paymentId: cheaper.id, amount: '2500', currency: 'usd' },
          actual: { amount: '2400', currency: 'usd' },
        }),
        finding({
          tenantId: TENANT_B,
          kind: 'amount_mismatch',
          sourceKey: eurosRef.sourceKey,
          expected: { paymentId: euros.id, amount: '2500', currency: 'usd' },
          actual: { amount: '2500', currency: 'eur' },
        }),
        finding({
          tenantId: TENANT_A,
          kind: 'amount_mismatch',
          sourceKey: noneRef.sourceKey,
          expected: { paymentId: none.id, amount: '2500', currency: 'usd' },
          actual: { amount: null, currency: null },
        }),
      ]),
    );
  });

  it("tenant_mismatch: the ref's tenant holds no such entry (the entry is another tenant's)", async () => {
    const paid = payment(TENANT_A);
    const ref = await posted('charge', paid, { entryTenant: TENANT_B });

    await expect(run()).resolves.toEqual([
      finding({
        tenantId: TENANT_A,
        kind: 'tenant_mismatch',
        sourceKey: ref.sourceKey,
        expected: { entryId: ref.entryId, tenantId: TENANT_A },
        actual: { tenantId: null },
      }),
    ]);
  });

  it('status_mismatch: refunded without a net refund, disputed without an open dispute, succeeded with either', async () => {
    const refunded = payment(TENANT_A, { status: PaymentStatus.Refunded });
    await posted('charge', refunded);
    await posted('refund', refunded);
    await posted('refund_failure', refunded);
    const partly = payment(TENANT_A, { status: PaymentStatus.PartiallyRefunded });
    await posted('charge', partly);
    const disputed = payment(TENANT_B, { status: PaymentStatus.Disputed });
    await posted('charge', disputed);
    await posted('dispute', disputed);
    await posted('dispute_reversal', disputed);
    const refundedButSucceeded = payment(TENANT_B);
    await posted('charge', refundedButSucceeded);
    await posted('refund', refundedButSucceeded);
    const disputedButSucceeded = payment(TENANT_A);
    await posted('charge', disputedButSucceeded);
    await posted('dispute', disputedButSucceeded);

    const found = await run();

    const status = (
      pay: PaidPaymentRow,
      actual: { netRefunds: number; openDisputes: number },
    ): LedgerDiscrepancyInput =>
      finding({
        tenantId: pay.tenantId,
        kind: 'status_mismatch',
        sourceKey: `payment:${pay.id}`,
        expected: { status: pay.status },
        actual,
      });
    expect(found).toHaveLength(5);
    expect(found).toEqual(
      expect.arrayContaining([
        status(refunded, { netRefunds: 0, openDisputes: 0 }),
        status(partly, { netRefunds: 0, openDisputes: 0 }),
        status(disputed, { netRefunds: 0, openDisputes: 0 }),
        status(refundedButSucceeded, { netRefunds: 1, openDisputes: 0 }),
        status(disputedButSucceeded, { netRefunds: 0, openDisputes: 1 }),
      ]),
    );
  });

  it('a refund that failed after a full or partial refund leaves a status R3 agrees with (no status_mismatch)', async () => {
    const later = new Date(PAID.getTime() + MINUTE);
    const afterFull = makePayment({ status: PaymentStatus.Succeeded, amountTotal: 2_500 });
    afterFull.refund(2_500, true, later);
    afterFull.failRefund(2_500, later);
    const afterPartial = makePayment({ status: PaymentStatus.Succeeded, amountTotal: 2_500 });
    afterPartial.refund(500, false, later);
    afterPartial.failRefund(500, later);
    for (const aggregate of [afterFull, afterPartial]) {
      const row = payment(TENANT_A, { id: aggregate.id, status: aggregate.status });
      await posted('charge', row);
      await posted('refund', row);
      await posted('refund_failure', row);
    }

    await expect(run()).resolves.toEqual([]);
  });

  it('pairs a payment and its ref that sit on different pages', async () => {
    const payments = Array.from({ length: R3_PAGE_SIZE + 1 }, () => payment(TENANT_A));
    const refs: LedgerEntryRef[] = [];
    for (const pay of payments) refs.push(await posted('charge', pay));
    const pageOf = <T>(rows: readonly T[], key: (row: T) => string, row: T) =>
      Math.floor([...rows].map(key).sort().indexOf(key(row)) / R3_PAGE_SIZE);
    // The keyset orders differ (payment id vs entry id): some pair is split across pages.
    const split = payments.filter((pay, i) => {
      const ref = refs[i] as LedgerEntryRef;
      return pageOf(payments, (p) => p.id, pay) !== pageOf(refs, (r) => r.entryId, ref);
    });
    expect(split.length).toBeGreaterThan(0);
    const listPayments = vi.spyOn(store.system, 'listSucceededPayments');
    const listRefs = vi.spyOn(store.system, 'listEntryRefs');

    await expect(run()).resolves.toEqual([]);
    expect(listPayments).toHaveBeenCalledTimes(2);
    expect(listRefs).toHaveBeenCalledTimes(2);
    for (const call of [...listPayments.mock.calls, ...listRefs.mock.calls]) {
      expect(call[3]).toBe(R3_PAGE_SIZE);
    }
  });

  it('does not report a payment paid 5 minutes ago (after the window, in the grace period)', async () => {
    payment(TENANT_A, { paidAt: new Date(NOW.getTime() - 5 * MINUTE) });

    await expect(run()).resolves.toEqual([]);
  });

  it('pairs across the window edges: a ref posted in the grace period, a payment paid just before the window', async () => {
    const late = payment(TENANT_A, { paidAt: new Date(TO.getTime() - 1_000) });
    await posted('charge', late, { postedAt: new Date(TO.getTime() + MINUTE) });
    const early = payment(TENANT_B, { paidAt: new Date(FROM.getTime() - MINUTE) });
    await posted('charge', early, { postedAt: new Date(FROM.getTime() + 1_000) });

    await expect(run()).resolves.toEqual([]);
  });

  it('lists payments from 24 h before the window and both lists up to the end of the grace period', async () => {
    const listPayments = vi.spyOn(store.system, 'listSucceededPayments');
    const listRefs = vi.spyOn(store.system, 'listEntryRefs');

    await run();

    const listFrom = new Date(FROM.getTime() - 24 * 60 * MINUTE);
    const listTo = new Date(TO.getTime() + 15 * MINUTE);
    expect(listPayments).toHaveBeenCalledWith(listFrom, listTo, null, R3_PAGE_SIZE);
    expect(listRefs).toHaveBeenCalledWith(listFrom, listTo, null, R3_PAGE_SIZE);
  });

  it('runs only inside SystemContext (its lists are system methods)', async () => {
    await expect(check.run(ctx)).rejects.toMatchObject({ code: 'SYSTEM_CONTEXT_REQUIRED' });
  });
});

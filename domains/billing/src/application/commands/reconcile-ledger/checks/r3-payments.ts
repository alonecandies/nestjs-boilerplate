import { Injectable } from '@nestjs/common';
import { LEDGER_RECONCILE_GRACE_MS } from '../../../../billing.constants.js';
import type { LedgerEntryKind } from '../../../../domain/ledger/ledger.types.js';
import type { LedgerDiscrepancyInput } from '../../../../domain/ledger/ledger-discrepancy.js';
import { PaymentStatus } from '../../../../domain/payment-status.enum.js';
import { LedgerPort } from '../../../ports/ledger.port.js';
import {
  type LedgerCursor,
  LedgerSystemRepository,
  PAID_PAYMENT_STATUSES,
  type PaidPaymentRow,
} from '../../../repositories/ledger.system-repository.js';
import type { LedgerEntryRef } from '../../../repositories/ledger-receipts.repository.js';
import type { ReconciliationCheck, ReconciliationContext } from '../reconcile-ledger.command.js';
import { keysetPages } from './keyset-pages.js';

/** Page size of both system lists. */
export const R3_PAGE_SIZE = 500;
/** Payments are listed from this long before the window, so a ref early in it finds its payment. */
export const R3_PAYMENT_LOOKBEHIND_MS = 24 * 3_600_000;

const key = (tenantId: string, id: string) => `${tenantId}/${id}`;
const inWindow = (at: Date, ctx: ReconciliationContext) =>
  at.getTime() >= ctx.from.getTime() && at.getTime() < ctx.to.getTime();
const count = (refs: readonly LedgerEntryRef[], kind: LedgerEntryKind) =>
  refs.filter((ref) => ref.kind === kind).length;

/**
 * R3, billing's payments against the ledger (ledger design §4; outbox plan Task 15). Reads every
 * page (`R3_PAGE_SIZE`) of `listSucceededPayments` and `listEntryRefs` over
 * `[from − 24 h, to + grace)` and joins them in memory by tenant and payment id; only rows of the
 * window `[from, to)` are reported, so a payment paid during the grace period is not, and a pair
 * whose payment and ref fall on either side of a window edge still pairs. Findings:
 * - a paid payment of the window without a `charge` ref → `payment_without_entry`
 *   (source key `payment:<id>`);
 * - a `charge` ref of the window with no payment id, or one that is not a paid payment of its
 *   tenant → `entry_without_payment` (the ref's source key); a ref whose payment the window's list
 *   does not hold (paid before the lookback) is looked up by id (`findPaymentsByIds`, batches of
 *   `R3_PAGE_SIZE`) before it is reported;
 * - per payment of the window and each of its `charge` refs, from `LedgerPort.getEntry(ref tenant,
 *   entry id)`: no such entry under the ref's tenant → `tenant_mismatch`; a presentment amount or
 *   currency other than the payment's → `amount_mismatch`;
 * - a status the refs disagree with (`refunded` or `partially_refunded` without a net refund ref,
 *   `disputed` without an open dispute ref, `succeeded` with either) → `status_mismatch`
 *   (source key `payment:<id>`).
 * Everything is read through system methods: the check runs only inside `SystemContext`.
 */
@Injectable()
export class R3PaymentsCheck implements ReconciliationCheck {
  readonly name = 'R3';

  constructor(
    private readonly ledger: LedgerPort,
    private readonly system: LedgerSystemRepository,
  ) {}

  async run(ctx: ReconciliationContext): Promise<readonly LedgerDiscrepancyInput[]> {
    const listFrom = new Date(ctx.from.getTime() - R3_PAYMENT_LOOKBEHIND_MS);
    const listTo = new Date(ctx.to.getTime() + LEDGER_RECONCILE_GRACE_MS);
    const payments: PaidPaymentRow[] = [];
    for await (const page of keysetPages(
      R3_PAGE_SIZE,
      (last: PaidPaymentRow) => ({ tenantId: last.tenantId, id: last.id }),
      (after) => this.system.listSucceededPayments(listFrom, listTo, after, R3_PAGE_SIZE),
    )) {
      payments.push(...page);
    }
    const refs: LedgerEntryRef[] = [];
    for await (const page of keysetPages(
      R3_PAGE_SIZE,
      (last: LedgerEntryRef) => ({ tenantId: last.tenantId, id: last.entryId }),
      (after) => this.system.listEntryRefs(listFrom, listTo, after, R3_PAGE_SIZE),
    )) {
      refs.push(...page);
    }
    const paid = new Set(payments.map((payment) => key(payment.tenantId, payment.id)));
    const refsByPayment = Map.groupBy(
      refs.filter((ref) => ref.paymentId !== null),
      (ref) => key(ref.tenantId, ref.paymentId ?? ''),
    );

    const meta = { detectedBy: this.name, runId: ctx.runId } as const;
    const found: LedgerDiscrepancyInput[] = [];
    for (const payment of payments) {
      if (!inWindow(payment.paidAt, ctx)) continue;
      const own = refsByPayment.get(key(payment.tenantId, payment.id)) ?? [];
      const charges = own.filter((ref) => ref.kind === 'charge');
      if (charges.length === 0) {
        found.push({
          tenantId: payment.tenantId,
          kind: 'payment_without_entry',
          sourceKey: `payment:${payment.id}`,
          expected: { kind: 'charge', paymentId: payment.id },
          actual: { entries: 0 },
          ...meta,
        });
      }
      for (const charge of charges) {
        const finding = await this.compareEntry(payment, charge);
        if (finding !== null) found.push({ ...finding, ...meta });
      }
      const status = statusFinding(payment, own);
      if (status !== null) found.push({ ...status, ...meta });
    }
    const unpaired = refs.filter(
      (ref) =>
        ref.kind === 'charge' &&
        inWindow(ref.postedAt, ctx) &&
        !(ref.paymentId !== null && paid.has(key(ref.tenantId, ref.paymentId))),
    );
    const paidOutsideList = await this.paidByIds(unpaired);
    for (const ref of unpaired) {
      if (ref.paymentId !== null && paidOutsideList.has(key(ref.tenantId, ref.paymentId))) continue;
      found.push({
        tenantId: ref.tenantId,
        kind: 'entry_without_payment',
        sourceKey: ref.sourceKey,
        expected: { paymentId: ref.paymentId },
        actual: { payment: null },
        ...meta,
      });
    }
    return found;
  }

  /**
   * The keys of the paid payments `refs` name that the window's list did not hold (paid before the
   * lookback, the ref recorded late): looked up by `(tenant, payment id)` in batches of
   * `R3_PAGE_SIZE`, so a late ref pairs with its payment wherever its `paidAt` lies.
   */
  private async paidByIds(refs: readonly LedgerEntryRef[]): Promise<Set<string>> {
    const keys = new Map<string, LedgerCursor>();
    for (const ref of refs) {
      if (ref.paymentId === null) continue;
      keys.set(key(ref.tenantId, ref.paymentId), { tenantId: ref.tenantId, id: ref.paymentId });
    }
    const paid = new Set<string>();
    const all = [...keys.values()];
    for (let i = 0; i < all.length; i += R3_PAGE_SIZE) {
      for (const row of await this.system.findPaymentsByIds(all.slice(i, i + R3_PAGE_SIZE))) {
        if (PAID_PAYMENT_STATUSES.includes(row.status)) paid.add(key(row.tenantId, row.id));
      }
    }
    return paid;
  }

  /** The entry of a `charge` ref against its payment: tenant first, then the presentment. */
  private async compareEntry(
    payment: PaidPaymentRow,
    charge: LedgerEntryRef,
  ): Promise<Omit<LedgerDiscrepancyInput, 'detectedBy' | 'runId'> | null> {
    const entry = await this.ledger.getEntry(charge.tenantId, charge.entryId);
    if (entry === null) {
      return {
        tenantId: charge.tenantId,
        kind: 'tenant_mismatch',
        sourceKey: charge.sourceKey,
        expected: { entryId: charge.entryId, tenantId: charge.tenantId },
        actual: { tenantId: null },
      };
    }
    const expectedAmount = payment.amountTotal?.toString() ?? null;
    const expectedCurrency = payment.currency?.toLowerCase() ?? null;
    const actualAmount = entry.presentment?.amount.toString() ?? null;
    const actualCurrency = entry.presentment?.currency.toLowerCase() ?? null;
    if (expectedAmount === actualAmount && expectedCurrency === actualCurrency) return null;
    return {
      tenantId: payment.tenantId,
      kind: 'amount_mismatch',
      sourceKey: charge.sourceKey,
      expected: { paymentId: payment.id, amount: expectedAmount, currency: expectedCurrency },
      actual: { amount: actualAmount, currency: actualCurrency },
    };
  }
}

/** The payment's status against its refs: net refunds and open disputes. */
function statusFinding(
  payment: PaidPaymentRow,
  refs: readonly LedgerEntryRef[],
): Omit<LedgerDiscrepancyInput, 'detectedBy' | 'runId'> | null {
  const netRefunds = count(refs, 'refund') - count(refs, 'refund_failure');
  const openDisputes = count(refs, 'dispute') - count(refs, 'dispute_reversal');
  const agrees =
    payment.status === PaymentStatus.Refunded || payment.status === PaymentStatus.PartiallyRefunded
      ? netRefunds > 0
      : payment.status === PaymentStatus.Disputed
        ? openDisputes > 0
        : netRefunds <= 0 && openDisputes <= 0;
  if (agrees) return null;
  return {
    tenantId: payment.tenantId,
    kind: 'status_mismatch',
    sourceKey: `payment:${payment.id}`,
    expected: { status: payment.status },
    actual: { netRefunds, openDisputes },
  };
}

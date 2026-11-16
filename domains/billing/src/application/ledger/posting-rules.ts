import type Stripe from 'stripe';
import {
  LEDGER_CHART,
  type LedgerAccountCode,
  type LedgerEntryDraft,
  type LedgerEntryKind,
  type LedgerLine,
  PLATFORM_TENANT_ID,
} from '../../domain/ledger/ledger.types.js';

export type PostingBalanceTransaction = Pick<
  Stripe.BalanceTransaction,
  'id' | 'amount' | 'fee' | 'currency' | 'created' | 'reporting_category' | 'source'
>;

export interface PostingContext {
  readonly tenantId: string;
  readonly paymentId: string | null;
  readonly presentment: { readonly amount: bigint; readonly currency: string } | null;
}

const KIND_BY_CATEGORY: Readonly<Record<string, LedgerEntryKind>> = {
  charge: 'charge',
  refund: 'refund',
  refund_failure: 'refund_failure',
  dispute: 'dispute',
  dispute_reversal: 'dispute_reversal',
  payout: 'payout',
  payout_reversal: 'payout_failure',
  fee: 'stripe_fee',
};

const COUNTER_ACCOUNT: Readonly<Record<LedgerEntryKind, LedgerAccountCode>> = {
  charge: 'revenue:checkout',
  refund: 'contra_revenue:refunds',
  refund_failure: 'contra_revenue:refunds',
  dispute: 'contra_revenue:disputes',
  dispute_reversal: 'contra_revenue:disputes',
  payout: 'asset:bank',
  payout_failure: 'asset:bank',
  stripe_fee: 'expense:stripe_fees',
  adjustment: 'equity:adjustments',
};

const PLATFORM_KINDS: readonly LedgerEntryKind[] = [
  'payout',
  'payout_failure',
  'stripe_fee',
  'adjustment',
];

export function ledgerKindOf(reportingCategory: string): LedgerEntryKind {
  return KIND_BY_CATEGORY[reportingCategory] ?? 'adjustment';
}

/**
 * One ledger entry per Stripe balance transaction (spec 2.4). Amounts are the balance
 * transaction's (settlement currency); fees come only from it. `null` when no money moves.
 */
export function draftFromBalanceTransaction(
  txn: PostingBalanceTransaction,
  context: PostingContext,
): LedgerEntryDraft | null {
  const amount = BigInt(txn.amount);
  const fee = BigInt(txn.fee);
  if (amount === 0n && fee === 0n) return null;
  const kind = ledgerKindOf(txn.reporting_category);
  const platformLevel = PLATFORM_KINDS.includes(kind);
  const tenantId = platformLevel ? PLATFORM_TENANT_ID : context.tenantId;
  const currency = txn.currency.toLowerCase();
  const line = (account: LedgerAccountCode, debit: bigint, credit: bigint): LedgerLine => ({
    account,
    accountOwnerTenantId:
      LEDGER_CHART[account].owner === 'platform' ? PLATFORM_TENANT_ID : tenantId,
    currency,
    debit,
    credit,
  });
  const pair = (counter: LedgerAccountCode, signed: bigint): LedgerLine[] =>
    signed > 0n
      ? [line('asset:stripe_balance', signed, 0n), line(counter, 0n, signed)]
      : [line(counter, -signed, 0n), line('asset:stripe_balance', 0n, -signed)];
  const feeAccount: LedgerAccountCode =
    kind === 'dispute' || kind === 'dispute_reversal'
      ? 'expense:dispute_fees'
      : 'expense:stripe_fees';
  const lines = [
    ...(amount === 0n ? [] : pair(COUNTER_ACCOUNT[kind], amount)),
    // A fee is money leaving the balance: the mirror image of an amount.
    ...(fee === 0n ? [] : pair(feeAccount, -fee)),
  ];
  const source = txn.source;
  return {
    sourceKey: `stripe:txn:${txn.id}`,
    tenantId,
    kind,
    paymentId: platformLevel ? null : context.paymentId,
    stripeObjectId: source === null ? null : typeof source === 'string' ? source : source.id,
    presentment: platformLevel ? null : context.presentment,
    occurredAt: new Date(txn.created * 1_000),
    lines,
  };
}

/** Tenant id of platform-level rows (payouts, unattributed fees). B2 never issues the nil UUID. */
export { PLATFORM_TENANT_ID } from '@platform/common';
/** uuidv5 namespace of every ledger id. A code constant, never env: changing it re-keys the ledger. */
export const LEDGER_NAMESPACE = '9402cabc-4fa0-4891-9ed1-389e5828479d';

export type LedgerAccountCode =
  | 'asset:stripe_balance'
  | 'asset:bank'
  | 'revenue:checkout'
  | 'contra_revenue:refunds'
  | 'contra_revenue:disputes'
  | 'expense:stripe_fees'
  | 'expense:dispute_fees'
  | 'equity:adjustments';

export type LedgerAccountKind =
  | 'asset'
  | 'liability'
  | 'equity'
  | 'revenue'
  | 'contra_revenue'
  | 'expense';

/** Chart of accounts (spec 2.3): Stripe Checkout, one Stripe account, the platform sells to tenants. */
export const LEDGER_CHART: Readonly<
  Record<
    LedgerAccountCode,
    { readonly kind: LedgerAccountKind; readonly owner: 'platform' | 'tenant' }
  >
> = {
  'asset:stripe_balance': { kind: 'asset', owner: 'platform' },
  'asset:bank': { kind: 'asset', owner: 'platform' },
  'revenue:checkout': { kind: 'revenue', owner: 'tenant' },
  'contra_revenue:refunds': { kind: 'contra_revenue', owner: 'tenant' },
  'contra_revenue:disputes': { kind: 'contra_revenue', owner: 'tenant' },
  'expense:stripe_fees': { kind: 'expense', owner: 'platform' },
  'expense:dispute_fees': { kind: 'expense', owner: 'platform' },
  'equity:adjustments': { kind: 'equity', owner: 'platform' },
};

export type LedgerEntryKind =
  | 'charge'
  | 'refund'
  | 'refund_failure'
  | 'dispute'
  | 'dispute_reversal'
  | 'payout'
  | 'payout_failure'
  | 'stripe_fee'
  | 'adjustment';

export interface LedgerLine {
  readonly account: LedgerAccountCode;
  /** The entry's tenant for tenant accounts, `PLATFORM_TENANT_ID` for platform accounts. */
  readonly accountOwnerTenantId: string;
  /** Lowercase ISO 4217 (Stripe's settlement currency of the balance transaction). */
  readonly currency: string;
  /** Minor units; exactly one of debit/credit is > 0n. */
  readonly debit: bigint;
  readonly credit: bigint;
}

export interface LedgerEntryDraft {
  /** Origin, e.g. `stripe:txn:txn_…`; the entry id is derived from it. */
  readonly sourceKey: string;
  readonly tenantId: string;
  readonly kind: LedgerEntryKind;
  readonly paymentId: string | null;
  readonly stripeObjectId: string | null;
  /** What the customer paid, in presentment currency (reconciliation R3); null when n/a. */
  readonly presentment: { readonly amount: bigint; readonly currency: string } | null;
  readonly occurredAt: Date;
  readonly lines: readonly LedgerLine[];
}

export type LedgerPostOutcome =
  | {
      readonly status: 'posted';
      readonly entryId: string;
      readonly payloadHash: string;
      readonly immudbTxId: bigint;
    }
  | { readonly status: 'replayed'; readonly entryId: string; readonly payloadHash: string }
  | {
      readonly status: 'conflict';
      readonly entryId: string;
      readonly payloadHash: string;
      readonly existingPayloadHash: string;
    };

export interface LedgerPosting {
  readonly line: number;
  readonly accountId: string;
  readonly currency: string;
  readonly debit: bigint;
  readonly credit: bigint;
}

export interface LedgerEntry {
  readonly id: string;
  readonly sourceKey: string;
  readonly tenantId: string;
  readonly kind: LedgerEntryKind;
  readonly paymentId: string | null;
  readonly stripeObjectId: string | null;
  readonly presentment: { readonly amount: bigint; readonly currency: string } | null;
  readonly payloadHash: string;
  readonly occurredAt: Date;
  readonly recordedAt: Date;
  readonly postings: readonly LedgerPosting[];
}

export interface LedgerBalance {
  readonly accountId: string;
  /** `null` when the id matches no chart account of the tenant or the platform in that currency. */
  readonly account: LedgerAccountCode | null;
  readonly currency: string;
  readonly debit: bigint;
  readonly credit: bigint;
}

/** An entry whose postings do not balance in `currency`, or (`currency: null`) has < 2 postings. */
export interface LedgerImbalance {
  readonly entryId: string;
  /** The entry's tenant (reconciliation R1 files the finding under it). */
  readonly tenantId: string;
  readonly currency: string | null;
  readonly debit: bigint;
  readonly credit: bigint;
  readonly postings: number;
}

/** A verified immudb state kept outside immudb (Postgres, wave 2) for tamper evidence (R5). */
export interface LedgerTrustedState {
  readonly database: string;
  readonly txId: bigint;
  readonly txHash: Uint8Array;
}

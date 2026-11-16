import { describe, expect, it } from 'vitest';
import { LEDGER_TEST_TENANT as TENANT } from '../../../test/ledger-fixtures.js';
import { assertBalanced } from '../../domain/ledger/ledger.invariant.js';
import { type LedgerLine, PLATFORM_TENANT_ID } from '../../domain/ledger/ledger.types.js';
import {
  draftFromBalanceTransaction,
  ledgerKindOf,
  type PostingBalanceTransaction,
  type PostingContext,
} from './posting-rules.js';

const PAYMENT = '0192f0c1-0000-7000-8000-0000000000aa';
const context: PostingContext = {
  tenantId: TENANT,
  paymentId: PAYMENT,
  presentment: { amount: 2_500n, currency: 'usd' },
};
const txn = (overrides: Partial<PostingBalanceTransaction>): PostingBalanceTransaction => ({
  id: 'txn_1',
  amount: 2_500,
  fee: 103,
  currency: 'usd',
  created: 1_794_182_400,
  reporting_category: 'charge',
  source: 'ch_1',
  ...overrides,
});
const P = PLATFORM_TENANT_ID;
const l = (
  account: LedgerLine['account'],
  owner: string,
  debit: bigint,
  credit: bigint,
): LedgerLine => ({
  account,
  accountOwnerTenantId: owner,
  currency: 'usd',
  debit,
  credit,
});

describe('posting rules', () => {
  it.each([
    ['charge', 'charge'],
    ['refund', 'refund'],
    ['refund_failure', 'refund_failure'],
    ['dispute', 'dispute'],
    ['dispute_reversal', 'dispute_reversal'],
    ['payout', 'payout'],
    ['payout_reversal', 'payout_failure'],
    ['fee', 'stripe_fee'],
    ['other_adjustment', 'adjustment'],
  ])('reporting_category %s → %s', (category, kind) => {
    expect(ledgerKindOf(category)).toBe(kind);
  });

  it.each<[string, Partial<PostingBalanceTransaction>, string, LedgerLine[]]>([
    [
      'charge',
      {},
      TENANT,
      [
        l('asset:stripe_balance', P, 2_500n, 0n),
        l('revenue:checkout', TENANT, 0n, 2_500n),
        l('expense:stripe_fees', P, 103n, 0n),
        l('asset:stripe_balance', P, 0n, 103n),
      ],
    ],
    [
      'refund',
      { reporting_category: 'refund', amount: -1_000, fee: 0, source: 're_1' },
      TENANT,
      [l('contra_revenue:refunds', TENANT, 1_000n, 0n), l('asset:stripe_balance', P, 0n, 1_000n)],
    ],
    [
      'refund failure',
      { reporting_category: 'refund_failure', amount: 1_000, fee: 0 },
      TENANT,
      [l('asset:stripe_balance', P, 1_000n, 0n), l('contra_revenue:refunds', TENANT, 0n, 1_000n)],
    ],
    [
      'dispute',
      { reporting_category: 'dispute', amount: -2_500, fee: 1_500, source: 'du_1' },
      TENANT,
      [
        l('contra_revenue:disputes', TENANT, 2_500n, 0n),
        l('asset:stripe_balance', P, 0n, 2_500n),
        l('expense:dispute_fees', P, 1_500n, 0n),
        l('asset:stripe_balance', P, 0n, 1_500n),
      ],
    ],
    [
      'dispute reversal with the fee refunded',
      { reporting_category: 'dispute_reversal', amount: 2_500, fee: -1_500 },
      TENANT,
      [
        l('asset:stripe_balance', P, 2_500n, 0n),
        l('contra_revenue:disputes', TENANT, 0n, 2_500n),
        l('asset:stripe_balance', P, 1_500n, 0n),
        l('expense:dispute_fees', P, 0n, 1_500n),
      ],
    ],
    [
      'payout',
      { reporting_category: 'payout', amount: -10_000, fee: 0, source: 'po_1' },
      P,
      [l('asset:bank', P, 10_000n, 0n), l('asset:stripe_balance', P, 0n, 10_000n)],
    ],
    [
      'payout reversal',
      { reporting_category: 'payout_reversal', amount: 10_000, fee: 0 },
      P,
      [l('asset:stripe_balance', P, 10_000n, 0n), l('asset:bank', P, 0n, 10_000n)],
    ],
    [
      'stripe fee',
      { reporting_category: 'fee', amount: -200, fee: 0, source: null },
      P,
      [l('expense:stripe_fees', P, 200n, 0n), l('asset:stripe_balance', P, 0n, 200n)],
    ],
    [
      'adjustment',
      { reporting_category: 'other_adjustment', amount: 50, fee: 0 },
      P,
      [l('asset:stripe_balance', P, 50n, 0n), l('equity:adjustments', P, 0n, 50n)],
    ],
  ])('%s', (_name, overrides, tenantId, lines) => {
    const draft = draftFromBalanceTransaction(txn(overrides), context);
    expect(draft).not.toBeNull();
    expect(draft?.tenantId).toBe(tenantId);
    expect(draft?.lines).toEqual(lines);
    if (draft !== null) expect(() => assertBalanced(draft)).not.toThrow();
  });

  it('carries the source, the payment and the presentment for tenant entries only', () => {
    expect(draftFromBalanceTransaction(txn({}), context)).toMatchObject({
      sourceKey: 'stripe:txn:txn_1',
      kind: 'charge',
      paymentId: PAYMENT,
      stripeObjectId: 'ch_1',
      presentment: { amount: 2_500n, currency: 'usd' },
      occurredAt: new Date('2026-11-09T00:00:00.000Z'),
    });
    expect(
      draftFromBalanceTransaction(
        txn({ reporting_category: 'payout', amount: -5, fee: 0, source: { id: 'po_9' } as never }),
        context,
      ),
    ).toMatchObject({
      tenantId: PLATFORM_TENANT_ID,
      paymentId: null,
      presentment: null,
      stripeObjectId: 'po_9',
    });
  });

  it('posts nothing when no money moves', () => {
    expect(draftFromBalanceTransaction(txn({ amount: 0, fee: 0 }), context)).toBeNull();
  });
});

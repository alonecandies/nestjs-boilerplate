import type { LedgerEntryDraft } from '../src/domain/ledger/ledger.types.js';
import { PLATFORM_TENANT_ID } from '../src/domain/ledger/ledger.types.js';

export const LEDGER_TEST_TENANT = '0192f0c1-0000-7000-8000-000000000001';
const TENANT = LEDGER_TEST_TENANT;

/** A Stripe charge of 25.00 USD with a 1.03 USD fee (spec 2.4 first row). */
export const CHARGE_DRAFT: LedgerEntryDraft = {
  sourceKey: 'stripe:txn:txn_1',
  tenantId: TENANT,
  kind: 'charge',
  paymentId: '0192f0c1-0000-7000-8000-0000000000aa',
  stripeObjectId: 'ch_1',
  presentment: { amount: 2_500n, currency: 'usd' },
  occurredAt: new Date('2026-11-09T00:00:00.000Z'),
  lines: [
    {
      account: 'asset:stripe_balance',
      accountOwnerTenantId: PLATFORM_TENANT_ID,
      currency: 'usd',
      debit: 2_500n,
      credit: 0n,
    },
    {
      account: 'revenue:checkout',
      accountOwnerTenantId: TENANT,
      currency: 'usd',
      debit: 0n,
      credit: 2_500n,
    },
    {
      account: 'expense:stripe_fees',
      accountOwnerTenantId: PLATFORM_TENANT_ID,
      currency: 'usd',
      debit: 103n,
      credit: 0n,
    },
    {
      account: 'asset:stripe_balance',
      accountOwnerTenantId: PLATFORM_TENANT_ID,
      currency: 'usd',
      debit: 0n,
      credit: 103n,
    },
  ],
};

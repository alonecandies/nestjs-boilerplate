import { PLATFORM_TENANT_ID } from '@platform/common';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CHARGE_DRAFT,
  LEDGER_TEST_TENANT as TENANT_A,
} from '../../../../../test/ledger-fixtures.js';
import { ledgerEntryId } from '../../../../domain/ledger/ledger.ids.js';
import type { LedgerEntryDraft, LedgerLine } from '../../../../domain/ledger/ledger.types.js';
import { InMemoryLedger } from '../../../../testing/in-memory-ledger.js';
import { R1InvariantCheck } from './r1-invariant.js';

const RUN_ID = '0197d000-0000-7000-8000-000000000001';
const FROM = new Date('2026-11-16T11:45:00.000Z');
const TO = new Date('2026-11-19T11:45:00.000Z');
const INSIDE = new Date('2026-11-19T10:00:00.000Z');
const BEFORE = new Date('2026-11-16T11:44:59.999Z');
const ctx = { runId: RUN_ID, from: FROM, to: TO };

const line = (
  account: LedgerLine['account'],
  currency: string,
  debit: bigint,
  credit: bigint,
): LedgerLine => ({
  account,
  accountOwnerTenantId: account === 'revenue:checkout' ? TENANT_A : PLATFORM_TENANT_ID,
  currency,
  debit,
  credit,
});

/** One entry balanced per currency in USD and EUR. */
const TWO_CURRENCIES: LedgerEntryDraft = {
  ...CHARGE_DRAFT,
  sourceKey: 'stripe:txn:txn_r1_two_currencies',
  lines: [
    line('asset:stripe_balance', 'usd', 2_500n, 0n),
    line('revenue:checkout', 'usd', 0n, 2_500n),
    line('asset:stripe_balance', 'eur', 900n, 0n),
    line('revenue:checkout', 'eur', 0n, 900n),
  ],
};

/** The same shape, off by 1 minor unit in EUR only. */
const OFF_BY_ONE: LedgerEntryDraft = {
  ...TWO_CURRENCIES,
  sourceKey: 'stripe:txn:txn_r1_off_by_one',
  lines: [
    line('asset:stripe_balance', 'usd', 2_500n, 0n),
    line('revenue:checkout', 'usd', 0n, 2_500n),
    line('asset:stripe_balance', 'eur', 901n, 0n),
    line('revenue:checkout', 'eur', 0n, 900n),
  ],
};

describe('R1InvariantCheck (reconciliation R1: the double-entry invariant)', () => {
  let recordedAt: Date;
  let ledger: InMemoryLedger;
  let check: R1InvariantCheck;

  beforeEach(() => {
    recordedAt = INSIDE;
    ledger = new InMemoryLedger(() => recordedAt);
    check = new R1InvariantCheck(ledger);
  });

  it('is R1', () => {
    expect(check.name).toBe('R1');
  });

  it('finds nothing in a ledger whose entries balance per currency, in two currencies', async () => {
    await ledger.post(CHARGE_DRAFT);
    await ledger.post(TWO_CURRENCIES);

    await expect(check.run(ctx)).resolves.toEqual([]);
  });

  it('reports an entry off by 1 minor unit in one currency under its tenant, and the currency under the platform', async () => {
    await ledger.post(TWO_CURRENCIES);
    const entryId = ledger.forge(OFF_BY_ONE);

    await expect(check.run(ctx)).resolves.toEqual([
      {
        tenantId: TENANT_A,
        kind: 'unbalanced_entry',
        sourceKey: `ledger_entries:${entryId}`,
        expected: { currency: 'eur', difference: '0' },
        actual: { currency: 'eur', debit: '901', credit: '900', postings: 2 },
        detectedBy: 'R1',
        runId: RUN_ID,
      },
      {
        tenantId: PLATFORM_TENANT_ID,
        kind: 'unbalanced_currency',
        sourceKey: 'currency:eur',
        expected: { currency: 'eur', difference: '0' },
        actual: { currency: 'eur', difference: '1' },
        detectedBy: 'R1',
        runId: RUN_ID,
      },
    ]);
  });

  it('reports an entry with fewer than two postings', async () => {
    const entryId = ledger.forge({
      ...CHARGE_DRAFT,
      sourceKey: 'stripe:txn:txn_r1_one_line',
      lines: [line('asset:stripe_balance', 'usd', 5n, 0n)],
    });

    const found = await check.run(ctx);

    expect(found).toContainEqual({
      tenantId: TENANT_A,
      kind: 'unbalanced_entry',
      sourceKey: `ledger_entries:${entryId}`,
      expected: { minPostings: 2 },
      actual: { postings: 1 },
      detectedBy: 'R1',
      runId: RUN_ID,
    });
  });

  it('reads entries of the window only; the global totals still see one recorded before it', async () => {
    recordedAt = BEFORE;
    ledger.forge(OFF_BY_ONE);
    recordedAt = INSIDE;
    await ledger.post(CHARGE_DRAFT);

    const found = await check.run(ctx);

    expect(found.map((f) => f.kind)).toEqual(['unbalanced_currency']);
    expect(found[0]?.sourceKey).toBe('currency:eur');
  });

  it('finds the same findings again for the same ledger (same discrepancy ids, nothing new)', async () => {
    ledger.forge(OFF_BY_ONE);
    const first = await check.run(ctx);
    await ledger.post(CHARGE_DRAFT);

    await expect(check.run(ctx)).resolves.toEqual(first);
    expect(ledgerEntryId(OFF_BY_ONE.sourceKey)).toBe(
      first[0]?.sourceKey.slice('ledger_entries:'.length),
    );
  });
});

import { describe, expect, it } from 'vitest';
import { CHARGE_DRAFT } from '../../../test/ledger-fixtures.js';
import { LedgerUnbalancedException } from './ledger.errors.js';
import { assertBalanced } from './ledger.invariant.js';
import { type LedgerEntryDraft, type LedgerLine, PLATFORM_TENANT_ID } from './ledger.types.js';

const problemsOf = (draft: LedgerEntryDraft): readonly string[] => {
  try {
    assertBalanced(draft);
  } catch (error) {
    if (error instanceof LedgerUnbalancedException) return error.problems;
    throw error;
  }
  return [];
};
const line = (overrides: Partial<LedgerLine>): LedgerLine => ({
  account: 'asset:stripe_balance',
  accountOwnerTenantId: PLATFORM_TENANT_ID,
  currency: 'usd',
  debit: 1n,
  credit: 0n,
  ...overrides,
});

describe('assertBalanced', () => {
  it('accepts a balanced multi-line entry', () => {
    expect(problemsOf(CHARGE_DRAFT)).toEqual([]);
  });

  it.each<[string, Partial<LedgerEntryDraft>, RegExp]>([
    ['one line', { lines: [line({})] }, /at least 2 lines/],
    [
      'debit and credit both set',
      { lines: [line({ credit: 1n }), line({ debit: 0n, credit: 1n })] },
      /exactly one of debit or credit/,
    ],
    [
      'a zero line',
      { lines: [line({ debit: 0n }), line({ debit: 0n, credit: 1n })] },
      /exactly one of debit or credit/,
    ],
    [
      'a negative amount',
      { lines: [line({ debit: -1n }), line({ debit: 0n, credit: -1n })] },
      /negative/,
    ],
    [
      'an uppercase currency',
      { lines: [line({ currency: 'USD' }), line({ currency: 'USD', debit: 0n, credit: 1n })] },
      /currency/,
    ],
    [
      'unbalanced per currency',
      { lines: [line({}), line({ currency: 'eur', debit: 0n, credit: 1n })] },
      /usd: debit 1 ≠ credit 0/,
    ],
    [
      'a platform account owned by a tenant',
      {
        lines: [
          line({ accountOwnerTenantId: CHARGE_DRAFT.tenantId }),
          line({ debit: 0n, credit: 1n }),
        ],
      },
      /asset:stripe_balance must be owned by the platform/,
    ],
    [
      'a tenant account owned by another tenant',
      {
        lines: [
          line({}),
          line({
            account: 'revenue:checkout',
            accountOwnerTenantId: '0192f0c1-0000-7000-8000-000000000002',
            debit: 0n,
            credit: 1n,
          }),
        ],
      },
      /revenue:checkout must be owned by the entry tenant/,
    ],
    ['a malformed tenant', { tenantId: 'tenant-1' }, /tenantId/],
    ['an empty source key', { sourceKey: '' }, /sourceKey/],
    ['a negative presentment', { presentment: { amount: -1n, currency: 'usd' } }, /presentment/],
  ])('rejects %s', (_name, overrides, problem) => {
    expect(problemsOf({ ...CHARGE_DRAFT, ...overrides })).toEqual(
      expect.arrayContaining([expect.stringMatching(problem)]),
    );
  });

  it('throws LedgerUnbalancedException with code LEDGER_ENTRY_INVALID', () => {
    expect(() => assertBalanced({ ...CHARGE_DRAFT, lines: [] })).toThrow(
      expect.objectContaining({ code: 'LEDGER_ENTRY_INVALID' }),
    );
  });
});

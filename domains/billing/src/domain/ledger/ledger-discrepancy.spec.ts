import { describe, expect, it } from 'vitest';
import { type LedgerDiscrepancyInput, ledgerDiscrepancyId } from './ledger-discrepancy.js';

const FINDING: Pick<LedgerDiscrepancyInput, 'kind' | 'sourceKey' | 'expected' | 'actual'> = {
  kind: 'payment_without_entry',
  sourceKey: 'payment:0197c400-0000-7000-8000-0000000000a1',
  expected: { amount: '2500', currency: 'usd' },
  actual: { amount: null },
};

describe('ledgerDiscrepancyId (outbox plan Task 11, spec delta 6)', () => {
  it('is the pinned uuidv5 of kind, source key and the sha256 of the canonical objects', () => {
    // uuidv5(LEDGER_NAMESPACE, 'discrepancy:payment_without_entry:payment:…a1:' +
    //   sha256('{"actual":{"amount":null},"expected":{"amount":"2500","currency":"usd"}}'))
    expect(ledgerDiscrepancyId(FINDING)).toBe('4030d2f3-cb25-5085-be94-0d24ebab2883');
  });

  it('ignores the key order of expected and actual', () => {
    expect(
      ledgerDiscrepancyId({
        ...FINDING,
        expected: { currency: 'usd', amount: '2500' },
        actual: { amount: null },
      }),
    ).toBe(ledgerDiscrepancyId(FINDING));
  });

  it('ignores the fields outside the identity (tenant, detector, run)', () => {
    const full: LedgerDiscrepancyInput = {
      ...FINDING,
      tenantId: '0197c400-0000-7000-8000-0000000000b0',
      detectedBy: 'R3',
      runId: '0197c400-0000-7000-8000-0000000000c0',
    };
    const fromConsumer: LedgerDiscrepancyInput = { ...full, detectedBy: 'consumer', runId: null };
    expect(ledgerDiscrepancyId(full)).toBe(ledgerDiscrepancyId(FINDING));
    expect(ledgerDiscrepancyId(fromConsumer)).toBe(ledgerDiscrepancyId(FINDING));
  });

  it('changes with the kind, the source key, expected or actual', () => {
    const base = ledgerDiscrepancyId(FINDING);
    const variants = [
      { ...FINDING, kind: 'entry_without_payment' as const },
      { ...FINDING, sourceKey: 'payment:0197c400-0000-7000-8000-0000000000a2' },
      { ...FINDING, expected: { amount: '2501', currency: 'usd' } },
      { ...FINDING, expected: { amount: 2500, currency: 'usd' } },
      { ...FINDING, actual: { amount: '0' } },
      { ...FINDING, actual: {} },
    ];
    const ids = variants.map(ledgerDiscrepancyId);
    expect(new Set([base, ...ids]).size).toBe(variants.length + 1);
  });
});

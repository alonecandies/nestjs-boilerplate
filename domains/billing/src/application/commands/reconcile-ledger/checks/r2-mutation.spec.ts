import { PLATFORM_TENANT_ID } from '@platform/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CHARGE_DRAFT } from '../../../../../test/ledger-fixtures.js';
import { InMemoryLedger } from '../../../../testing/in-memory-ledger.js';
import { R2MutationCheck } from './r2-mutation.js';

const RUN_ID = '0197d000-0000-7000-8000-000000000002';
const ctx = {
  runId: RUN_ID,
  from: new Date('2026-11-16T11:45:00.000Z'),
  to: new Date('2026-11-19T11:45:00.000Z'),
};

describe('R2MutationCheck (reconciliation R2: no ledger row was ever rewritten)', () => {
  let ledger: InMemoryLedger;
  let check: R2MutationCheck;

  beforeEach(() => {
    ledger = new InMemoryLedger();
    check = new R2MutationCheck(ledger);
  });

  it('is R2', () => {
    expect(check.name).toBe('R2');
  });

  it('finds nothing in a ledger that was only appended to', async () => {
    await ledger.post(CHARGE_DRAFT);
    await ledger.post({ ...CHARGE_DRAFT, sourceKey: 'stripe:txn:txn_r2_second' });

    await expect(check.run(ctx)).resolves.toEqual([]);
  });

  it('reports a rewritten row under the platform tenant, source key <table>:<id>', async () => {
    const { entryId } = await ledger.post(CHARGE_DRAFT);
    ledger.tamper(entryId, (entry) => ({ ...entry, kind: 'adjustment' }));

    await expect(check.run(ctx)).resolves.toEqual([
      {
        tenantId: PLATFORM_TENANT_ID,
        kind: 'ledger_row_mutated',
        sourceKey: `ledger_entries:${entryId}`,
        expected: { rev: '1' },
        actual: { rev: '2' },
        detectedBy: 'R2',
        runId: RUN_ID,
      },
    ]);
  });

  it('reports rows of every ledger table the port names, whatever the window', async () => {
    vi.spyOn(ledger, 'findMutations').mockResolvedValue([
      { table: 'ledger_postings', id: 'e1:1', rev: 3n },
      { table: 'ledger_accounts', id: 'a1', rev: 2n },
    ]);

    const found = await check.run(ctx);

    expect(found.map((f) => [f.sourceKey, f.actual])).toEqual([
      ['ledger_postings:e1:1', { rev: '3' }],
      ['ledger_accounts:a1', { rev: '2' }],
    ]);
  });

  it('a further rewrite of the same row is a new finding (another revision)', async () => {
    const { entryId } = await ledger.post(CHARGE_DRAFT);
    ledger.tamper(entryId, (entry) => ({ ...entry, kind: 'adjustment' }));
    const [first] = await check.run(ctx);
    ledger.tamper(entryId, (entry) => ({ ...entry, kind: 'charge' }));

    const [second] = await check.run(ctx);

    expect(first?.actual).toEqual({ rev: '2' });
    expect(second?.actual).toEqual({ rev: '3' });
  });
});

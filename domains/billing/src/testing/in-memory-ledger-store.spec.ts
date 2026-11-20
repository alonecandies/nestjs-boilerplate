import {
  createPrincipal,
  PLATFORM_TENANT_ID,
  runWithPrincipal,
  SystemContext,
} from '@platform/common';
import { describe, expect, it } from 'vitest';
import type { LedgerEntryRef } from '../application/repositories/ledger-receipts.repository.js';
import { ledgerAccountId } from '../domain/ledger/ledger.ids.js';
import { ledgerDiscrepancyId } from '../domain/ledger/ledger-discrepancy.js';
import { PaymentStatus } from '../domain/payment-status.enum.js';
import { InMemoryLedgerStore } from './in-memory-ledger-store.js';

const id = (suffix: string): string => `0197c500-0000-7000-8000-${suffix.padStart(12, '0')}`;
const TENANT_A = id('a0');
const TENANT_B = id('b0');
const a1 = createPrincipal({ userId: id('1a1'), tenantId: TENANT_A, roles: [] });
const inSystem = <T>(work: () => Promise<T>): Promise<T> =>
  SystemContext.run('billing.in-memory-ledger-spec', work);
const FROM = new Date('2026-11-10T00:00:00.000Z');
const TO = new Date('2026-11-11T00:00:00.000Z');

const ref = (tenantId: string, entryId: string, postedAt = FROM): LedgerEntryRef => ({
  tenantId,
  entryId,
  sourceKey: `stripe:txn:${entryId}`,
  payloadHash: 'h',
  immudbTxId: 1n,
  paymentId: null,
  kind: 'charge',
  postedAt,
});

describe('InMemoryLedgerStore (the twin of the two ledger repositories)', () => {
  it('receipts: as the principal, idempotent; another tenant is 42501; no principal is refused', async () => {
    const store = new InMemoryLedgerStore();
    await expect(
      runWithPrincipal(a1, () => store.receipts.recordEntryRef(ref(TENANT_A, id('e1')))),
    ).resolves.toBe(true);
    await expect(
      runWithPrincipal(a1, () => store.receipts.recordEntryRef(ref(TENANT_A, id('e1')))),
    ).resolves.toBe(false);
    await expect(
      runWithPrincipal(a1, () => store.receipts.recordEntryRef(ref(TENANT_B, id('e2')))),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(store.receipts.recordEntryRef(ref(TENANT_A, id('e3')))).rejects.toMatchObject({
      code: 'RLS_NO_PRINCIPAL',
    });
    const fees = {
      tenantId: TENANT_A,
      code: 'expense:stripe_fees' as const,
      currency: 'usd',
      immudbAccountId: ledgerAccountId(PLATFORM_TENANT_ID, 'expense:stripe_fees', 'usd'),
    };
    await expect(runWithPrincipal(a1, () => store.receipts.recordAccounts([fees]))).rejects.toThrow(
      /platform-owned/,
    );
    const finding = {
      tenantId: TENANT_A,
      kind: 'post_conflict' as const,
      sourceKey: 'stripe:txn:t',
      expected: { payloadHash: 'a' },
      actual: { payloadHash: 'b' },
      detectedBy: 'consumer' as const,
      runId: null,
    };
    await expect(
      runWithPrincipal(a1, () => store.receipts.appendDiscrepancy(finding)),
    ).resolves.toBe(true);
    await expect(
      runWithPrincipal(a1, () => store.receipts.appendDiscrepancy(finding)),
    ).resolves.toBe(false);
    expect(store.entryRefs).toHaveLength(1);
    expect(store.discrepancies.map((row) => row.id)).toEqual([ledgerDiscrepancyId(finding)]);
  });

  it('system: SystemContext only; keyset pages in (tenant, id) order within [from, to)', async () => {
    const store = new InMemoryLedgerStore();
    await expect(store.system.listEntryRefs(FROM, TO, null, 10)).rejects.toMatchObject({
      code: 'SYSTEM_CONTEXT_REQUIRED',
    });
    const rows = [
      ref(TENANT_B, id('e1')),
      ref(PLATFORM_TENANT_ID, id('e2')),
      ref(TENANT_A, id('e3')),
      ref(TENANT_A, id('e4'), TO),
    ];
    await expect(
      inSystem(() => store.system.recordEntryRefs([...rows, rows[0] ?? expect.fail()])),
    ).resolves.toBe(4);
    const first = await inSystem(() => store.system.listEntryRefs(FROM, TO, null, 2));
    const last = first.at(-1) ?? expect.fail();
    const second = await inSystem(() =>
      store.system.listEntryRefs(FROM, TO, { tenantId: last.tenantId, id: last.entryId }, 2),
    );
    expect([...first, ...second].map((row) => row.tenantId)).toEqual([
      PLATFORM_TENANT_ID,
      TENANT_A,
      TENANT_B,
    ]);
    store.addPayments(
      {
        tenantId: TENANT_A,
        id: id('p1'),
        userId: id('1a1'),
        status: PaymentStatus.Disputed,
        amountTotal: 1n,
        currency: 'usd',
        paidAt: FROM,
      },
      {
        tenantId: TENANT_A,
        id: id('p2'),
        userId: id('1a1'),
        status: PaymentStatus.Failed,
        amountTotal: 1n,
        currency: 'usd',
        paidAt: FROM,
      },
    );
    const paid = await inSystem(() => store.system.listSucceededPayments(FROM, TO, null, 10));
    expect(paid.map((row) => row.id)).toEqual([id('p1')]);
  });

  it('system: trusted state compare-and-set, runs finish once, postings land in the outbox', async () => {
    const store = new InMemoryLedgerStore();
    const s1 = { database: 'ledger', txId: 1n, txHash: new Uint8Array([1]) };
    const s2 = { database: 'ledger', txId: 2n, txHash: new Uint8Array([2]) };
    const READ_1 = new Date('2026-11-10T10:00:00.000Z');
    const READ_2 = new Date('2026-11-10T11:00:00.000Z');
    await expect(
      inSystem(() => store.system.advanceTrustedState('ledger', null, s1, READ_1)),
    ).resolves.toBe(true);
    await expect(
      inSystem(() => store.system.advanceTrustedState('ledger', null, s1, READ_1)),
    ).resolves.toBe(false);
    await expect(
      inSystem(() => store.system.advanceTrustedState('ledger', s1, s2, READ_2)),
    ).resolves.toBe(true);
    await expect(
      inSystem(() => store.system.advanceTrustedState('ledger', s1, s2, READ_2)),
    ).resolves.toBe(false);
    await expect(
      inSystem(() => store.system.advanceTrustedState('ledger', s2, s1, READ_2)),
    ).rejects.toThrow(/backwards/);
    await expect(inSystem(() => store.system.readTrustedState('ledger'))).resolves.toMatchObject({
      txId: 2n,
      txHash: new Uint8Array([2]),
      readAt: READ_2,
    });

    await inSystem(() => store.system.startRun({ id: id('r1'), from: FROM, to: TO }));
    await inSystem(() =>
      store.system.finishRun(id('r1'), 'succeeded', { found: { a: 1 }, appended: { a: 1 } }),
    );
    await inSystem(() => store.system.finishRun(id('r1'), 'failed', { found: {}, appended: {} }));
    expect(store.runs.get(id('r1'))).toMatchObject({
      status: 'succeeded',
      counts: { found: { a: 1 } },
    });

    const record = {
      tenantId: TENANT_A,
      id: id('o1'),
      topic: 't',
      key: TENANT_A,
      envelope: { id: id('o1'), tenantId: TENANT_A } as never,
    };
    await expect(
      inSystem(() => store.system.enqueueMissingPostings([record, record])),
    ).resolves.toBe(1);
    const poll = await inSystem(() => store.outbox.pollUnpublished(10));
    expect(poll.rows.map((row) => row.id)).toEqual([id('o1')]);
    await expect(
      inSystem(() =>
        store.system.recordPlatformAccounts([
          { tenantId: TENANT_A, code: 'asset:bank', currency: 'usd', immudbAccountId: id('x') },
        ]),
      ),
    ).rejects.toThrow(/PLATFORM_TENANT_ID/);
  });
});

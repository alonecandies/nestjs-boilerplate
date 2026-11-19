import {
  createPrincipal,
  PLATFORM_TENANT_ID,
  runWithPrincipal,
  SystemContext,
} from '@platform/common';
import { register } from 'prom-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CHARGE_DRAFT, LEDGER_TEST_TENANT as TENANT_A } from '../../../../test/ledger-fixtures.js';
import { ledgerAccountId, ledgerEntryId } from '../../../domain/ledger/ledger.ids.js';
import type { LedgerEntryDraft } from '../../../domain/ledger/ledger.types.js';
import {
  LEDGER_DISCREPANCIES_TOTAL,
  LEDGER_POST_DURATION_SECONDS,
  LEDGER_POSTINGS_TOTAL,
} from '../../../infrastructure/ledger/ledger-metrics.js';
import { InMemoryLedger } from '../../../testing/in-memory-ledger.js';
import { InMemoryLedgerStore } from '../../../testing/in-memory-ledger-store.js';
import { LedgerService } from '../../ledger/ledger.service.js';
import { PostLedgerEntryCommand } from './post-ledger-entry.command.js';
import { PostLedgerEntryHandler } from './post-ledger-entry.handler.js';

const USER_A1 = '0192f0c1-0000-7000-8000-00000000a001';
const TENANT_B = '0192f0c1-0000-7000-8000-000000000002';
const principalA = createPrincipal({ userId: USER_A1, tenantId: TENANT_A, roles: [] });
const asA = <T>(fn: () => Promise<T>) => runWithPrincipal(principalA, fn);
const asSystem = <T>(fn: () => Promise<T>) => SystemContext.run('billing.ledger-posting', fn);

/** The charge draft with every amount multiplied (another payload under the same source key). */
const scaled = (draft: LedgerEntryDraft, factor: bigint): LedgerEntryDraft => ({
  ...draft,
  lines: draft.lines.map((l) => ({ ...l, debit: l.debit * factor, credit: l.credit * factor })),
});

/** The charge draft owned by another tenant (the platform's lines stay the platform's). */
const ownedBy = (tenantId: string, sourceKey: string): LedgerEntryDraft => ({
  ...CHARGE_DRAFT,
  sourceKey,
  tenantId,
  lines: CHARGE_DRAFT.lines.map((l) =>
    l.account === 'revenue:checkout' ? { ...l, accountOwnerTenantId: tenantId } : l,
  ),
});

type Sample = { labels: Record<string, string>; value: number; metricName?: string };
const samples = async (name: string): Promise<Sample[]> => {
  const metric = register.getSingleMetric(name);
  return metric === undefined ? [] : ((await metric.get()).values as Sample[]);
};
const counted = async (name: string, labels: Record<string, string>) =>
  (await samples(name)).find((s) => Object.entries(labels).every(([k, v]) => s.labels[k] === v))
    ?.value ?? 0;

const account = (owner: string, code: string) => ({
  tenantId: owner,
  code,
  currency: 'usd',
  immudbAccountId: ledgerAccountId(owner, code as never, 'usd'),
});

describe('PostLedgerEntryHandler', () => {
  let ledger: InMemoryLedger;
  let store: InMemoryLedgerStore;
  let handler: PostLedgerEntryHandler;
  /** SystemContext reasons seen by recordPlatformAccounts, in call order. */
  let platformAccountReasons: (string | undefined)[];

  const execute = (draft: LedgerEntryDraft) => handler.execute(new PostLedgerEntryCommand(draft));

  beforeEach(() => {
    register.resetMetrics();
    ledger = new InMemoryLedger();
    store = new InMemoryLedgerStore();
    handler = new PostLedgerEntryHandler(new LedgerService(ledger), store.receipts, store.system);
    platformAccountReasons = [];
    const recordPlatformAccounts = store.system.recordPlatformAccounts.bind(store.system);
    vi.spyOn(store.system, 'recordPlatformAccounts').mockImplementation((rows) => {
      platformAccountReasons.push(SystemContext.current()?.reason);
      return recordPlatformAccounts(rows);
    });
  });

  it("posted: one ref with the tx id, the tenant's accounts through the runtime port and the platform's through the nested system call", async () => {
    const recordAccounts = vi.spyOn(store.receipts, 'recordAccounts');
    const recordEntryRefs = vi.spyOn(store.system, 'recordEntryRefs');

    const outcome = await asA(() => execute(CHARGE_DRAFT));

    expect(outcome).toMatchObject({ status: 'posted', immudbTxId: 1n });
    expect(store.entryRefs).toEqual([
      {
        tenantId: TENANT_A,
        entryId: ledgerEntryId(CHARGE_DRAFT.sourceKey),
        sourceKey: CHARGE_DRAFT.sourceKey,
        payloadHash: outcome.payloadHash,
        immudbTxId: 1n,
        paymentId: CHARGE_DRAFT.paymentId,
        kind: 'charge',
        postedAt: expect.any(Date),
      },
    ]);
    expect(recordAccounts).toHaveBeenCalledTimes(1);
    expect(recordAccounts).toHaveBeenCalledWith([account(TENANT_A, 'revenue:checkout')]);
    expect(store.system.recordPlatformAccounts).toHaveBeenCalledTimes(1);
    expect(store.system.recordPlatformAccounts).toHaveBeenCalledWith([
      account(PLATFORM_TENANT_ID, 'asset:stripe_balance'),
      account(PLATFORM_TENANT_ID, 'expense:stripe_fees'),
    ]);
    expect(platformAccountReasons).toEqual(['billing.ledger-platform-accounts']);
    expect(recordEntryRefs).not.toHaveBeenCalled();
    expect(store.accounts).toHaveLength(3);
    expect(await counted(LEDGER_POSTINGS_TOTAL, { outcome: 'posted' })).toBe(1);
    const duration = await samples(LEDGER_POST_DURATION_SECONDS);
    expect(duration.find((s) => s.metricName?.endsWith('_count'))?.value).toBe(1);
  });

  it('the same draft again returns replayed and adds nothing', async () => {
    await asA(() => execute(CHARGE_DRAFT));
    const refs = structuredClone(store.entryRefs);

    const outcome = await asA(() => execute(CHARGE_DRAFT));

    expect(outcome.status).toBe('replayed');
    expect(store.entryRefs).toEqual(refs);
    expect(store.entryRefs[0]?.immudbTxId).toBe(1n);
    expect(store.accounts).toHaveLength(3);
    expect(store.discrepancies).toEqual([]);
    expect(await counted(LEDGER_POSTINGS_TOTAL, { outcome: 'replayed' })).toBe(1);
  });

  it('the same source key with another amount appends one post_conflict carrying both hashes and changes no ref', async () => {
    const first = await asA(() => execute(CHARGE_DRAFT));
    const refs = structuredClone(store.entryRefs);

    const conflict = await asA(() => execute(scaled(CHARGE_DRAFT, 2n)));
    await asA(() => execute(scaled(CHARGE_DRAFT, 2n)));

    expect(conflict).toMatchObject({
      status: 'conflict',
      existingPayloadHash: first.payloadHash,
    });
    expect(store.entryRefs).toEqual(refs);
    expect(store.discrepancies).toEqual([
      expect.objectContaining({
        tenantId: TENANT_A,
        kind: 'post_conflict',
        sourceKey: CHARGE_DRAFT.sourceKey,
        expected: { entryId: first.entryId, payloadHash: first.payloadHash },
        actual: { entryId: first.entryId, payloadHash: conflict.payloadHash },
        detectedBy: 'consumer',
        runId: null,
      }),
    ]);
    expect(await counted(LEDGER_POSTINGS_TOTAL, { outcome: 'conflict' })).toBe(2);
    expect(await counted(LEDGER_DISCREPANCIES_TOTAL, { kind: 'post_conflict' })).toBe(1);
  });

  it('a ref write that fails after the post rejects; the rerun returns replayed and writes the ref', async () => {
    const outage = Object.assign(new Error('write CONNECTION_CLOSED'), {
      code: 'CONNECTION_CLOSED',
    });
    vi.spyOn(store.receipts, 'recordEntryRef').mockRejectedValueOnce(outage);

    await expect(asA(() => execute(CHARGE_DRAFT))).rejects.toBe(outage);
    expect(store.entryRefs).toEqual([]);

    const rerun = await asA(() => execute(CHARGE_DRAFT));

    expect(rerun.status).toBe('replayed');
    expect(store.entryRefs).toEqual([
      expect.objectContaining({
        tenantId: TENANT_A,
        entryId: ledgerEntryId(CHARGE_DRAFT.sourceKey),
        payloadHash: rerun.payloadHash,
        immudbTxId: null,
      }),
    ]);
    expect(store.accounts).toHaveLength(3);
  });

  it('a draft of another tenant is refused before the port and before any receipt', async () => {
    const recordEntryRef = vi.spyOn(store.receipts, 'recordEntryRef');
    const post = vi.spyOn(ledger, 'post');

    await expect(asA(() => execute(ownedBy(TENANT_B, 'stripe:txn:txn_b')))).rejects.toMatchObject({
      code: 'LEDGER_TENANT_MISMATCH',
    });
    expect(post).not.toHaveBeenCalled();
    expect(recordEntryRef).not.toHaveBeenCalled();
    expect(await counted(LEDGER_POSTINGS_TOTAL, { outcome: 'posted' })).toBe(0);
  });

  describe('in SystemContext the runtime port is never called', () => {
    let runtime: ReturnType<typeof vi.spyOn>[];

    beforeEach(() => {
      runtime = [
        vi.spyOn(store.receipts, 'recordEntryRef'),
        vi.spyOn(store.receipts, 'recordAccounts'),
        vi.spyOn(store.receipts, 'appendDiscrepancy'),
      ];
    });

    it('a platform draft: its ref and every account row go through LedgerSystemRepository', async () => {
      const payout = ownedBy(PLATFORM_TENANT_ID, 'stripe:txn:txn_platform');

      const outcome = await asSystem(() => execute(payout));

      expect(outcome.status).toBe('posted');
      expect(store.entryRefs).toEqual([
        expect.objectContaining({ tenantId: PLATFORM_TENANT_ID, immudbTxId: 1n }),
      ]);
      expect(store.system.recordPlatformAccounts).toHaveBeenCalledWith([
        account(PLATFORM_TENANT_ID, 'asset:stripe_balance'),
        account(PLATFORM_TENANT_ID, 'revenue:checkout'),
        account(PLATFORM_TENANT_ID, 'expense:stripe_fees'),
      ]);
      expect(platformAccountReasons).toEqual(['billing.ledger-posting']);
      for (const spy of runtime) expect(spy).not.toHaveBeenCalled();
    });

    it("a user-less tenant draft: its ref through the system pool, the platform's account rows only", async () => {
      const outcome = await asSystem(() => execute(CHARGE_DRAFT));

      expect(outcome.status).toBe('posted');
      expect(store.entryRefs).toEqual([
        expect.objectContaining({ tenantId: TENANT_A, immudbTxId: 1n }),
      ]);
      expect(store.accounts.map((a) => a.tenantId)).toEqual([
        PLATFORM_TENANT_ID,
        PLATFORM_TENANT_ID,
      ]);
      for (const spy of runtime) expect(spy).not.toHaveBeenCalled();
    });

    it('a conflict appends its finding through appendDiscrepancies', async () => {
      await asSystem(() => execute(CHARGE_DRAFT));
      const appendDiscrepancies = vi.spyOn(store.system, 'appendDiscrepancies');

      const outcome = await asSystem(() => execute(scaled(CHARGE_DRAFT, 3n)));

      expect(outcome.status).toBe('conflict');
      expect(appendDiscrepancies).toHaveBeenCalledTimes(1);
      expect(store.discrepancies).toEqual([
        expect.objectContaining({ tenantId: TENANT_A, kind: 'post_conflict' }),
      ]);
      for (const spy of runtime) expect(spy).not.toHaveBeenCalled();
    });
  });
});

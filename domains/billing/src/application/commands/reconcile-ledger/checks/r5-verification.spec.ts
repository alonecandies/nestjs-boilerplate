import { Logger } from '@nestjs/common';
import { PLATFORM_TENANT_ID, SystemContext } from '@platform/common';
import { register } from 'prom-client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHARGE_DRAFT,
  LEDGER_TEST_TENANT as TENANT_A,
} from '../../../../../test/ledger-fixtures.js';
import type { LedgerEntryDraft } from '../../../../domain/ledger/ledger.types.js';
import {
  LEDGER_UNVERIFIED_TX_LAG,
  LEDGER_VERIFIED_TX_ID,
  LedgerMetrics,
} from '../../../../infrastructure/ledger/ledger-metrics.js';
import { InMemoryLedger } from '../../../../testing/in-memory-ledger.js';
import { InMemoryLedgerStore } from '../../../../testing/in-memory-ledger-store.js';
import type { LedgerEntryRef } from '../../../repositories/ledger-receipts.repository.js';
import { ReconcileLedgerCommand } from '../reconcile-ledger.command.js';
import { ReconcileLedgerHandler } from '../reconcile-ledger.handler.js';
import type { R1InvariantCheck } from './r1-invariant.js';
import type { R2MutationCheck } from './r2-mutation.js';
import type { R3PaymentsCheck } from './r3-payments.js';
import type { R4StripeCheck } from './r4-stripe.js';
import { R5_REF_PAGE_SIZE, R5VerificationCheck } from './r5-verification.js';

const TENANT_B = '0192f0c1-0000-7000-8000-000000000002';
const HOUR = 3_600_000;
const NOW = new Date('2026-11-19T12:00:00.000Z');
const FROM = new Date(NOW.getTime() - 72 * HOUR);
const TO = new Date(NOW.getTime() - 15 * 60_000);
const DB = 'in-memory';
const asSystem = <T>(fn: () => Promise<T>) => SystemContext.run('billing.reconcile-ledger', fn);

type Sample = { labels: Record<string, string>; value: number };
const metric = async (name: string) => {
  const found = register.getSingleMetric(name);
  const values = found === undefined ? [] : ((await found.get()).values as Sample[]);
  return values[0]?.value;
};

/** A check that finds nothing (R1-R4 are not under test here). */
const quiet = <T>(name: string) => ({ name, run: async () => [] }) as unknown as T;

const draft = (n: number, tenantId = TENANT_A): LedgerEntryDraft => ({
  ...CHARGE_DRAFT,
  sourceKey: `stripe:txn:txn_r5_${n}`,
  tenantId,
  lines: CHARGE_DRAFT.lines.map((line) =>
    line.account === 'revenue:checkout' ? { ...line, accountOwnerTenantId: tenantId } : line,
  ),
});

describe('R5VerificationCheck (reconciliation R5: the trusted state and verified entries)', () => {
  let ledger: InMemoryLedger;
  let store: InMemoryLedgerStore;
  let check: R5VerificationCheck;
  let verified: string[];

  const handler = (verify = true) =>
    new ReconcileLedgerHandler(
      { enabled: true, reconcileLookbackHours: 72, verify, allowUnverified: false },
      store.system,
      quiet<R1InvariantCheck>('R1'),
      quiet<R2MutationCheck>('R2'),
      quiet<R3PaymentsCheck>('R3'),
      quiet<R4StripeCheck>('R4'),
      check,
      LedgerMetrics,
    );
  const reconcile = (verify = true) =>
    asSystem(() => handler(verify).execute(new ReconcileLedgerCommand({ from: FROM, to: TO })));
  const lastRun = () => [...store.runs.values()].at(-1);
  const trusted = () => store.trustedStates.get(DB);

  /**
   * Posts `n` through the ledger and records its ref as the consumer does (`posted`: its tx id);
   * `record: false` leaves the ref for the test to insert later.
   */
  const post = async (
    n: number,
    options: {
      tenantId?: string;
      replayed?: boolean;
      refHash?: string;
      postedAt?: Date;
      record?: boolean;
    } = {},
  ): Promise<LedgerEntryRef> => {
    const d = draft(n, options.tenantId);
    const outcome = await ledger.post(d);
    const ref: LedgerEntryRef = {
      tenantId: d.tenantId,
      entryId: outcome.entryId,
      sourceKey: d.sourceKey,
      payloadHash: options.refHash ?? outcome.payloadHash,
      immudbTxId:
        outcome.status === 'posted' && options.replayed !== true ? outcome.immudbTxId : null,
      paymentId: null,
      kind: d.kind,
      postedAt: options.postedAt ?? new Date(NOW.getTime() - HOUR),
    };
    if (options.record !== false) store.insertEntryRef(ref);
    return ref;
  };

  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    register.resetMetrics();
    ledger = new InMemoryLedger();
    store = new InMemoryLedgerStore();
    check = new R5VerificationCheck(ledger, store.system, LedgerMetrics);
    verified = [];
    const verifyEntry = ledger.verifyEntry.bind(ledger);
    vi.spyOn(ledger, 'verifyEntry').mockImplementation(async (entryId, hash, state) => {
      verified.push(entryId);
      return verifyEntry(entryId, hash, state);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is R5 and runs last, only with LEDGER_VERIFY=true', () => {
    expect(check.name).toBe('R5');
    expect(handler().checks.map((c) => c.name)).toEqual(['R1', 'R2', 'R3', 'R4', 'R5']);
    expect(handler(false).checks.map((c) => c.name)).toEqual(['R1', 'R2', 'R3', 'R4']);
  });

  it('the first run takes the current state on trust, stores it and verifies the refs of the window', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    const a = await post(1);
    const b = await post(2, { tenantId: TENANT_B });

    await expect(reconcile()).resolves.toEqual({ found: {}, appended: {} });

    const current = await ledger.currentState();
    expect(trusted()).toEqual({
      database: DB,
      txId: 2n,
      txHash: current.txHash,
      verifiedAt: NOW,
      readAt: NOW,
    });
    expect(verified.sort()).toEqual([a.entryId, b.entryId].sort());
    expect(lastRun()?.status).toBe('succeeded');
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ database: DB, txId: '2' }),
      expect.stringContaining('taken on trust'),
    );
    expect(await metric(LEDGER_VERIFIED_TX_ID)).toBe(2);
    expect(await metric(LEDGER_UNVERIFIED_TX_LAG)).toBe(0);
  });

  it('a later run advances the state and verifies exactly the refs above the old tx id plus the null-tx ones', async () => {
    await post(1);
    await post(2);
    const replayed = await post(3, { replayed: true });
    await reconcile();
    const first = trusted();
    expect(first?.txId).toBe(3n);
    verified = [];

    const c = await post(4);
    const d = await post(5, { tenantId: TENANT_B });
    vi.setSystemTime(new Date(NOW.getTime() + HOUR));
    await reconcile();

    expect(verified.sort()).toEqual([c.entryId, d.entryId, replayed.entryId].sort());
    expect(trusted()).toMatchObject({ txId: 5n, verifiedAt: new Date(NOW.getTime() + HOUR) });
    expect(lastRun()?.status).toBe('succeeded');
    expect(await metric(LEDGER_VERIFIED_TX_ID)).toBe(5);
  });

  it.each([
    ['at the instant the state was read', 0],
    ['long after the state was read (a stalled consumer)', 2 * HOUR],
  ])(
    'a ref recorded %s, whose tx the stored state includes, is verified by the next run',
    async (_, lateBy) => {
      await post(1);
      // Posted to immudb before the state is read; its ref reaches Postgres only after the run.
      const late = await post(2, { record: false, postedAt: new Date(NOW.getTime() + lateBy) });
      await reconcile();
      expect(trusted()?.txId).toBe(2n);
      expect(verified).not.toContain(late.entryId);
      store.insertEntryRef(late);
      verified = [];

      vi.setSystemTime(new Date(NOW.getTime() + 3 * HOUR));
      await reconcile();

      expect(verified).toEqual([late.entryId]);
      expect(lastRun()?.status).toBe('succeeded');
    },
  );

  it('a late ref with a wrong hash is still found by the next run', async () => {
    const late = await post(1, { record: false, postedAt: NOW, refHash: 'e'.repeat(64) });
    await reconcile();
    store.insertEntryRef(late);

    vi.setSystemTime(new Date(NOW.getTime() + HOUR));
    await reconcile();

    expect(store.discrepancies).toEqual([
      expect.objectContaining({
        kind: 'verification_failed',
        sourceKey: `ledger_entries:${late.entryId}`,
      }),
    ]);
  });

  it('lists the refs since min(from, the stored read time), page by page, up to when the state was read', async () => {
    await post(1);
    await reconcile();
    const list = vi.spyOn(store.system, 'listEntryRefs');
    // The stored state was read before the window starts: the refs since then are read.
    store.trustedStates.set(DB, {
      ...(trusted() ?? expect.fail('no state')),
      verifiedAt: new Date(FROM.getTime() - HOUR / 2),
      readAt: new Date(FROM.getTime() - HOUR),
    });

    await reconcile();

    expect(list.mock.calls[0]).toEqual([
      new Date(FROM.getTime() - HOUR),
      NOW,
      null,
      R5_REF_PAGE_SIZE,
    ]);
  });

  it('stores when the state was read, before a proof that took longer than 10 minutes', async () => {
    await post(1);
    // The proof takes 30 minutes: the compare-and-set stamps verifiedAt 30 minutes after the read.
    const advance = ledger.advanceTrustedState.bind(ledger);
    vi.spyOn(ledger, 'advanceTrustedState').mockImplementation(async (from) => {
      vi.setSystemTime(new Date(NOW.getTime() + 30 * 60_000));
      return advance(from);
    });

    await reconcile();

    expect(trusted()).toMatchObject({
      txId: 1n,
      readAt: NOW,
      verifiedAt: new Date(NOW.getTime() + 30 * 60_000),
    });
  });

  it('a proof longer than 10 minutes: a ref recorded during it is still verified by the next run', async () => {
    await post(1);
    // Posted to immudb before the state is read; its ref reaches Postgres a minute after the read,
    // while the 30-minute proof runs (so this run's listing, up to the read, does not see it).
    const late = await post(2, {
      record: false,
      postedAt: new Date(NOW.getTime() + 60_000),
    });
    const advance = ledger.advanceTrustedState.bind(ledger);
    const slowProof = vi.spyOn(ledger, 'advanceTrustedState').mockImplementation(async (from) => {
      vi.setSystemTime(new Date(NOW.getTime() + 30 * 60_000));
      return advance(from);
    });
    await reconcile();
    expect(trusted()?.txId).toBe(2n);
    expect(verified).not.toContain(late.entryId);
    store.insertEntryRef(late);
    slowProof.mockRestore();
    verified = [];

    vi.setSystemTime(new Date(NOW.getTime() + HOUR));
    await reconcile();

    expect(verified).toEqual([late.entryId]);
    expect(lastRun()?.status).toBe('succeeded');
  });

  it('a state stored without a read time (before 0008): the next run verifies every ref of its window once', async () => {
    const a = await post(1);
    const b = await post(2);
    await reconcile();
    store.trustedStates.set(DB, { ...(trusted() ?? expect.fail('no state')), readAt: null });
    verified = [];

    vi.setSystemTime(new Date(NOW.getTime() + HOUR));
    await reconcile();
    expect(verified.sort()).toEqual([a.entryId, b.entryId].sort());
    expect(trusted()?.readAt).toEqual(new Date(NOW.getTime() + HOUR));
    verified = [];

    vi.setSystemTime(new Date(NOW.getTime() + 2 * HOUR));
    await reconcile();
    expect(verified).toEqual([]);
  });

  it('an inconsistent history gives one verification_failed under the platform, no advance, no entry verified, a failed run', async () => {
    await post(1);
    await reconcile();
    const before = trusted();
    verified = [];
    await post(2);
    ledger.forkHistory();

    await expect(reconcile()).resolves.toEqual({
      found: { verification_failed: 1 },
      appended: { verification_failed: 1 },
    });

    expect(store.discrepancies).toEqual([
      expect.objectContaining({
        tenantId: PLATFORM_TENANT_ID,
        kind: 'verification_failed',
        sourceKey: `state:${DB}`,
        detectedBy: 'R5',
        runId: lastRun()?.id,
        expected: { txId: '1', txHash: Buffer.from(before?.txHash ?? []).toString('hex') },
      }),
    ]);
    expect(trusted()?.txId).toBe(before?.txId);
    expect(trusted()?.txHash).toEqual(before?.txHash);
    expect(verified).toEqual([]);
    expect(lastRun()?.status).toBe('failed');
    // The stored state still says tx 1; the store is at tx 2.
    expect(await metric(LEDGER_VERIFIED_TX_ID)).toBe(1);
    expect(await metric(LEDGER_UNVERIFIED_TX_LAG)).toBe(1);
  });

  it('after a re-anchor, a ref of the lost history is verified whatever its tx id, on every run, until its entry is back', async () => {
    const a = await post(1);
    const lostFrom = new Date(NOW.getTime() - 30 * 60_000);
    const b = await post(2, { postedAt: new Date(NOW.getTime() - 20 * 60_000) });
    const c = await post(3, { postedAt: new Date(NOW.getTime() - 10 * 60_000) });
    await reconcile();
    const before = trusted() ?? expect.fail('no state');
    expect(before.txId).toBe(3n);

    // The restore keeps A; one entry posted after it came back takes tx 2, B's old tx id.
    const restored = new InMemoryLedger();
    await restored.post(draft(1));
    await restored.post(draft(9));
    const state = await restored.currentState();
    expect(state.txId).toBe(2n);
    vi.setSystemTime(new Date(NOW.getTime() + HOUR));
    await expect(
      asSystem(() =>
        store.system.reanchorTrustedState({
          id: '0192f0c1-0000-7000-8000-00000000ae01',
          database: DB,
          from: before,
          to: state,
          lostFrom,
          operator: 'ops',
          reason: 'immudb restored from the nightly backup',
        }),
      ),
    ).resolves.toBe(true);
    expect(trusted()).toMatchObject({ txId: 2n, readAt: lostFrom });
    check = new R5VerificationCheck(restored, store.system, LedgerMetrics);
    const verifyEntry = restored.verifyEntry.bind(restored);
    vi.spyOn(restored, 'verifyEntry').mockImplementation(async (entryId, hash, trustedState) => {
      verified.push(entryId);
      return verifyEntry(entryId, hash, trustedState);
    });
    verified = [];

    // B (tx 2, not above the new state) and C (tx 3, above it): both lost, both found.
    vi.setSystemTime(new Date(NOW.getTime() + 2 * HOUR));
    await expect(reconcile()).resolves.toEqual({
      found: { verification_failed: 2 },
      appended: { verification_failed: 2 },
    });
    expect(verified.toSorted()).toEqual([b.entryId, c.entryId].toSorted());
    expect(store.discrepancies.map((row) => row.sourceKey).toSorted()).toEqual(
      [`ledger_entries:${b.entryId}`, `ledger_entries:${c.entryId}`].toSorted(),
    );

    // The posting path posts both again (their refs keep the old tx ids): every later run that
    // lists them verifies them again, and they now hold.
    await restored.post(draft(2));
    await restored.post(draft(3));
    for (const hours of [3, 4]) {
      verified = [];
      vi.setSystemTime(new Date(NOW.getTime() + hours * HOUR));
      await expect(reconcile()).resolves.toEqual({ found: {}, appended: {} });
      expect(verified.toSorted()).toEqual([b.entryId, c.entryId].toSorted());
      expect(lastRun()?.status).toBe('succeeded');
    }
    expect(verified).not.toContain(a.entryId);
  });

  it('after a second re-anchor, a ref lost in the first and still unhealed is verified and reported, whatever its tx id', async () => {
    const a = await post(1);
    const lostFrom1 = new Date(NOW.getTime() - 30 * 60_000);
    const b = await post(2, { postedAt: new Date(NOW.getTime() - 20 * 60_000) });
    const c = await post(3, { postedAt: new Date(NOW.getTime() - 10 * 60_000) });
    await reconcile();
    const before = trusted() ?? expect.fail('no state');
    expect(before.txId).toBe(3n);

    /** Re-anchors to `restored` (its current state) and swaps R5 onto it, recording what it verifies. */
    const reanchorOnto = async (restored: InMemoryLedger, id: string, lostFrom: Date) => {
      const from = trusted() ?? expect.fail('no state');
      const to = await restored.currentState();
      await expect(
        asSystem(() =>
          store.system.reanchorTrustedState({
            id,
            database: DB,
            from,
            to,
            lostFrom,
            operator: 'ops',
            reason: 'immudb restored from a backup',
          }),
        ),
      ).resolves.toBe(true);
      check = new R5VerificationCheck(restored, store.system, LedgerMetrics);
      const verifyEntry = restored.verifyEntry.bind(restored);
      vi.spyOn(restored, 'verifyEntry').mockImplementation(async (entryId, hash, state) => {
        verified.push(entryId);
        return verifyEntry(entryId, hash, state);
      });
    };

    // First restore: A only, then one entry that takes tx 2 (B's old tx id). B and C are lost.
    const first = new InMemoryLedger();
    await first.post(draft(1));
    await first.post(draft(9));
    vi.setSystemTime(new Date(NOW.getTime() + HOUR));
    await reanchorOnto(first, '0192f0c1-0000-7000-8000-00000000ae01', lostFrom1);
    verified = [];
    vi.setSystemTime(new Date(NOW.getTime() + 2 * HOUR));
    await expect(reconcile()).resolves.toMatchObject({ found: { verification_failed: 2 } });
    expect(verified.toSorted()).toEqual([b.entryId, c.entryId].toSorted());

    // Second restore, B and C still not posted again: its state (tx 4) is above both their tx ids
    // and its lost-from is after both were posted, so only the first re-anchor names them.
    const second = new InMemoryLedger();
    for (const n of [1, 9, 10, 11]) await second.post(draft(n));
    expect((await second.currentState()).txId).toBe(4n);
    vi.setSystemTime(new Date(NOW.getTime() + 3 * HOUR));
    await reanchorOnto(
      second,
      '0192f0c1-0000-7000-8000-00000000ae02',
      new Date(NOW.getTime() + 150 * 60_000),
    );
    verified = [];
    vi.setSystemTime(new Date(NOW.getTime() + 4 * HOUR));
    await expect(reconcile()).resolves.toMatchObject({ found: { verification_failed: 2 } });
    expect(verified.toSorted()).toEqual([b.entryId, c.entryId].toSorted());
    expect(lastRun()?.status).toBe('succeeded');

    // Healed: the posting path posts both again; every later run still verifies them, and they hold.
    await second.post(draft(2));
    await second.post(draft(3));
    for (const hours of [5, 6]) {
      verified = [];
      vi.setSystemTime(new Date(NOW.getTime() + hours * HOUR));
      await expect(reconcile()).resolves.toEqual({ found: {}, appended: {} });
      expect(verified.toSorted()).toEqual([b.entryId, c.entryId].toSorted());
    }
    expect(verified).not.toContain(a.entryId);
  });

  it('a trusted state ahead of the store fails the same way', async () => {
    await post(1);
    const ahead = {
      database: DB,
      txId: 9n,
      txHash: new Uint8Array(32).fill(7),
      verifiedAt: NOW,
      readAt: NOW,
    };
    store.trustedStates.set(DB, ahead);

    await reconcile();

    expect(store.discrepancies).toEqual([
      expect.objectContaining({
        tenantId: PLATFORM_TENANT_ID,
        kind: 'verification_failed',
        sourceKey: `state:${DB}`,
      }),
    ]);
    expect(trusted()).toEqual(ahead);
    expect(verified).toEqual([]);
    expect(lastRun()?.status).toBe('failed');
  });

  it('the same failed proof twice appends one row', async () => {
    await post(1);
    store.trustedStates.set(DB, {
      database: DB,
      txId: 9n,
      txHash: new Uint8Array(32),
      verifiedAt: NOW,
      readAt: NOW,
    });

    await reconcile();
    await expect(reconcile()).resolves.toEqual({
      found: { verification_failed: 1 },
      appended: { verification_failed: 0 },
    });
    expect(store.discrepancies).toHaveLength(1);
  });

  it('an entry whose hash differs from its ref → verification_failed under that tenant, the state still advances', async () => {
    await post(1);
    const bad = await post(2, { tenantId: TENANT_B, refHash: 'f'.repeat(64) });

    await reconcile();

    expect(store.discrepancies).toEqual([
      expect.objectContaining({
        tenantId: TENANT_B,
        kind: 'verification_failed',
        sourceKey: `ledger_entries:${bad.entryId}`,
        detectedBy: 'R5',
        expected: { entryId: bad.entryId, payloadHash: 'f'.repeat(64), immudbTxId: '2' },
      }),
    ]);
    expect(trusted()?.txId).toBe(2n);
    expect(lastRun()?.status).toBe('succeeded');
  });

  it('a lost compare-and-set fails the run without a finding, verifies nothing and does not retry', async () => {
    await post(1);
    const advance = vi.spyOn(store.system, 'advanceTrustedState').mockResolvedValue(false);

    await expect(reconcile()).resolves.toEqual({ found: {}, appended: {} });

    expect(advance).toHaveBeenCalledTimes(1);
    expect(store.discrepancies).toEqual([]);
    expect(verified).toEqual([]);
    expect(lastRun()?.status).toBe('failed');
  });

  it('LEDGER_VERIFY=false: the check does not run and the state is untouched', async () => {
    await post(1);
    const advance = vi.spyOn(ledger, 'advanceTrustedState');

    await reconcile(false);

    expect(advance).not.toHaveBeenCalled();
    expect(trusted()).toBeUndefined();
    expect(verified).toEqual([]);
    expect(lastRun()?.status).toBe('succeeded');
  });

  it('runs only inside SystemContext', async () => {
    await expect(check.run({ runId: 'r', from: FROM, to: TO })).rejects.toMatchObject({
      code: 'SYSTEM_CONTEXT_REQUIRED',
    });
  });
});

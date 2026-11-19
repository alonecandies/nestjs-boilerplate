import { createHash } from 'node:crypto';
import { LedgerPort } from '../application/ports/ledger.port.js';
import { resolveLedgerAccount } from '../domain/ledger/ledger.accounts.js';
import { LedgerVerificationFailedException } from '../domain/ledger/ledger.errors.js';
import {
  ledgerAccountId,
  ledgerEntryId,
  ledgerPayloadHash,
  toEpochMicros,
} from '../domain/ledger/ledger.ids.js';
import { assertBalanced } from '../domain/ledger/ledger.invariant.js';
import type {
  LedgerBalance,
  LedgerEntry,
  LedgerEntryDraft,
  LedgerImbalance,
  LedgerPostOutcome,
  LedgerTrustedState,
} from '../domain/ledger/ledger.types.js';

/**
 * `LedgerPort` in memory, with the same ids, hashes, replay/conflict and balance semantics. Two
 * tamper hooks stand in for a superuser on the immudb host (reconciliation fixtures): `forge`
 * writes an entry without the balance check, `tamper` rewrites a stored one and leaves a revision
 * that `findMutations` reports (R2).
 */
export class InMemoryLedger extends LedgerPort {
  private readonly entries = new Map<string, LedgerEntry>();
  /** Revision of each rewritten entry (absent: revision 1, never rewritten). */
  private readonly revisions = new Map<string, bigint>();
  private chain = new Uint8Array(32);
  private txId = 0n;

  constructor(private readonly now: () => Date = () => new Date()) {
    super();
  }

  override async post(draft: LedgerEntryDraft): Promise<LedgerPostOutcome> {
    assertBalanced(draft);
    const entryId = ledgerEntryId(draft.sourceKey);
    const payloadHash = ledgerPayloadHash(draft);
    const existing = this.entries.get(entryId);
    if (existing !== undefined) {
      return existing.payloadHash === payloadHash
        ? { status: 'replayed', entryId, payloadHash }
        : { status: 'conflict', entryId, payloadHash, existingPayloadHash: existing.payloadHash };
    }
    return { status: 'posted', entryId, payloadHash, immudbTxId: this.store(draft) };
  }

  /**
   * Test hook: stores `draft` as a new entry WITHOUT `assertBalanced` (a row the adapter would
   * never write, such as a superuser's INSERT), in its own transaction; returns the entry id.
   * @throws Error when the entry id exists
   */
  forge(draft: LedgerEntryDraft): string {
    const entryId = ledgerEntryId(draft.sourceKey);
    if (this.entries.has(entryId)) throw new Error(`ledger entry ${entryId} exists`);
    this.store(draft);
    return entryId;
  }

  /**
   * Test hook: rewrites a stored entry in place (an UPDATE on the immudb host): the entry gets a
   * new revision, which `findMutations` reports as `ledger_entries`.
   * @throws Error when no entry has that id
   */
  tamper(entryId: string, change: (entry: LedgerEntry) => LedgerEntry): void {
    const entry = this.entries.get(entryId);
    if (entry === undefined) throw new Error(`no ledger entry ${entryId}`);
    const changed = change(entry);
    this.entries.set(entryId, changed);
    this.revisions.set(entryId, (this.revisions.get(entryId) ?? 1n) + 1n);
    this.commit(changed.payloadHash);
  }

  private store(draft: LedgerEntryDraft): bigint {
    const entryId = ledgerEntryId(draft.sourceKey);
    const payloadHash = ledgerPayloadHash(draft);
    this.entries.set(entryId, {
      id: entryId,
      sourceKey: draft.sourceKey,
      tenantId: draft.tenantId,
      kind: draft.kind,
      paymentId: draft.paymentId,
      stripeObjectId: draft.stripeObjectId,
      presentment: draft.presentment,
      payloadHash,
      occurredAt: draft.occurredAt,
      recordedAt: this.now(),
      postings: draft.lines.map((line, i) => ({
        line: i + 1,
        accountId: ledgerAccountId(line.accountOwnerTenantId, line.account, line.currency),
        currency: line.currency,
        debit: line.debit,
        credit: line.credit,
      })),
    });
    return this.commit(payloadHash);
  }

  /** One immudb transaction: the next tx id and the hash chain over the written payload. */
  private commit(payloadHash: string): bigint {
    this.txId++;
    this.chain = new Uint8Array(
      createHash('sha256').update(this.chain).update(payloadHash).digest(),
    );
    return this.txId;
  }

  override async getEntry(tenantId: string, entryId: string): Promise<LedgerEntry | null> {
    const entry = this.entries.get(entryId);
    return entry?.tenantId === tenantId ? entry : null;
  }

  override async balances(tenantId: string, currency?: string): Promise<readonly LedgerBalance[]> {
    const sums = new Map<string, LedgerBalance>();
    for (const entry of this.entries.values()) {
      if (entry.tenantId !== tenantId) continue;
      for (const p of entry.postings) {
        if (currency !== undefined && p.currency !== currency) continue;
        const key = `${p.accountId}:${p.currency}`;
        const sum = sums.get(key) ?? {
          accountId: p.accountId,
          account: resolveLedgerAccount(p.accountId, tenantId, p.currency),
          currency: p.currency,
          debit: 0n,
          credit: 0n,
        };
        sums.set(key, { ...sum, debit: sum.debit + p.debit, credit: sum.credit + p.credit });
      }
    }
    return [...sums.values()];
  }

  override async findUnbalanced(window: {
    fromUs: bigint;
    toUs: bigint;
  }): Promise<readonly LedgerImbalance[]> {
    const found: LedgerImbalance[] = [];
    for (const entry of this.entries.values()) {
      const at = toEpochMicros(entry.recordedAt);
      if (at < window.fromUs || at >= window.toUs) continue;
      if (entry.postings.length < 2) {
        found.push({
          entryId: entry.id,
          tenantId: entry.tenantId,
          currency: null,
          debit: 0n,
          credit: 0n,
          postings: entry.postings.length,
        });
        continue;
      }
      const byCurrency = new Map<string, { debit: bigint; credit: bigint; postings: number }>();
      for (const p of entry.postings) {
        const sum = byCurrency.get(p.currency) ?? { debit: 0n, credit: 0n, postings: 0 };
        byCurrency.set(p.currency, {
          debit: sum.debit + p.debit,
          credit: sum.credit + p.credit,
          postings: sum.postings + 1,
        });
      }
      for (const [currency, sum] of byCurrency) {
        if (sum.debit !== sum.credit) {
          found.push({ entryId: entry.id, tenantId: entry.tenantId, currency, ...sum });
        }
      }
    }
    return found;
  }

  override async totalsByCurrency(): Promise<
    readonly { currency: string; debit: bigint; credit: bigint }[]
  > {
    const totals = new Map<string, { currency: string; debit: bigint; credit: bigint }>();
    for (const entry of this.entries.values()) {
      for (const p of entry.postings) {
        const sum = totals.get(p.currency) ?? { currency: p.currency, debit: 0n, credit: 0n };
        totals.set(p.currency, {
          ...sum,
          debit: sum.debit + p.debit,
          credit: sum.credit + p.credit,
        });
      }
    }
    return [...totals.values()].sort((a, b) => a.currency.localeCompare(b.currency));
  }

  /** The entries `tamper` rewrote, at their current revision (nothing else is ever mutated). */
  override async findMutations(): Promise<readonly { table: string; id: string; rev: bigint }[]> {
    return [...this.revisions]
      .map(([id, rev]) => ({ table: 'ledger_entries', id, rev }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  override async verifyEntry(
    entryId: string,
    expectedPayloadHash: string,
    trusted: LedgerTrustedState,
  ): Promise<void> {
    if (trusted.txId > this.txId) {
      throw new LedgerVerificationFailedException(entryId, 'trusted state is ahead of the ledger');
    }
    const entry = this.entries.get(entryId);
    if (entry === undefined) throw new LedgerVerificationFailedException(entryId, 'no such entry');
    if (entry.payloadHash !== expectedPayloadHash) {
      throw new LedgerVerificationFailedException(entryId, 'payload hash differs');
    }
  }

  override async advanceTrustedState(
    trusted: LedgerTrustedState | null,
  ): Promise<LedgerTrustedState> {
    if (trusted !== null && trusted.txId > this.txId) {
      throw new LedgerVerificationFailedException(
        'trusted-state',
        'trusted state is ahead of the ledger',
      );
    }
    return { database: 'in-memory', txId: this.txId, txHash: this.chain };
  }
}

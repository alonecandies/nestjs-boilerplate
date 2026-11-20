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

/** The database the in-memory states name (immudb's is the configured `IMMUDB_DATABASE`). */
export const IN_MEMORY_LEDGER_DATABASE = 'in-memory';

/**
 * `LedgerPort` in memory, with the same ids, hashes, replay/conflict and balance semantics. Every
 * transaction extends a hash chain (`currentState`); a trusted state is consistent when the chain
 * held its hash at its tx id. Three tamper hooks stand in for a superuser on the immudb host
 * (reconciliation fixtures): `forge` writes an entry without the balance check, `tamper` rewrites
 * a stored one and leaves a revision that `findMutations` reports (R2), `forkHistory` rewrites
 * the history itself so no earlier state is consistent any more (R5).
 */
export class InMemoryLedger extends LedgerPort {
  private readonly entries = new Map<string, LedgerEntry>();
  /** Revision of each rewritten entry (absent: revision 1, never rewritten). */
  private readonly revisions = new Map<string, bigint>();
  /** The payload hash each transaction wrote, by tx id - 1. */
  private readonly txPayloads: string[] = [];
  /** The chain hash after each transaction, by tx id (index 0: the empty ledger). */
  private chain: Uint8Array[] = [new Uint8Array(32)];
  private txId = 0n;
  private forks = 0;

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
    this.txPayloads.push(payloadHash);
    this.chain.push(link(this.chain.at(-1) ?? new Uint8Array(32), payloadHash));
    return this.txId;
  }

  /**
   * Test hook: rebuilds every transaction's hash from another genesis, as a history rewritten (or
   * restored from elsewhere) on the immudb host: the entries and tx ids stay, but no state taken
   * before is consistent with the store any more, so `advanceTrustedState` and `verifyEntry`
   * against it fail.
   */
  forkHistory(): void {
    this.forks++;
    const genesis = new Uint8Array(createHash('sha256').update(`fork:${this.forks}`).digest());
    const chain: Uint8Array[] = [genesis];
    for (const payloadHash of this.txPayloads) {
      chain.push(link(chain.at(-1) ?? genesis, payloadHash));
    }
    this.chain = chain;
  }

  /** @throws LedgerVerificationFailedException unless `trusted` is a state of this history */
  private assertConsistent(id: string, trusted: LedgerTrustedState): void {
    if (trusted.txId > this.txId) {
      throw new LedgerVerificationFailedException(id, 'trusted state is ahead of the ledger');
    }
    // Every history extends the empty state (immudb proves nothing from tx 0 either).
    if (trusted.txId === 0n) return;
    const hash = this.chain[Number(trusted.txId)];
    if (hash === undefined || !sameBytes(hash, trusted.txHash)) {
      throw new LedgerVerificationFailedException(
        id,
        `no valid consistency proof from tx ${trusted.txId} to tx ${this.txId}`,
      );
    }
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
    this.assertConsistent(entryId, trusted);
    const entry = this.entries.get(entryId);
    if (entry === undefined) throw new LedgerVerificationFailedException(entryId, 'no such entry');
    if (entry.payloadHash !== expectedPayloadHash) {
      throw new LedgerVerificationFailedException(entryId, 'payload hash differs');
    }
  }

  override async currentState(): Promise<LedgerTrustedState> {
    return {
      database: IN_MEMORY_LEDGER_DATABASE,
      txId: this.txId,
      txHash: new Uint8Array(this.chain[Number(this.txId)] ?? []),
    };
  }

  override async advanceTrustedState(
    trusted: LedgerTrustedState | null,
  ): Promise<LedgerTrustedState> {
    if (trusted !== null) this.assertConsistent('trusted-state', trusted);
    return this.currentState();
  }
}

function link(previous: Uint8Array, payloadHash: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(previous).update(payloadHash).digest());
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

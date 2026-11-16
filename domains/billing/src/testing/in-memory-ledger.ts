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

/** `LedgerPort` in memory, with the same ids, hashes, replay/conflict and balance semantics. */
export class InMemoryLedger extends LedgerPort {
  private readonly entries = new Map<string, LedgerEntry>();
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
    this.txId++;
    this.chain = new Uint8Array(
      createHash('sha256').update(this.chain).update(payloadHash).digest(),
    );
    return { status: 'posted', entryId, payloadHash, immudbTxId: this.txId };
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
        if (sum.debit !== sum.credit) found.push({ entryId: entry.id, currency, ...sum });
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

  /** Memory has no history: nothing is ever mutated. */
  override async findMutations(): Promise<readonly { table: string; id: string; rev: bigint }[]> {
    return [];
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

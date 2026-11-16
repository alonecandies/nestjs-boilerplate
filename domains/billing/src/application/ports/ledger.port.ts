import type {
  LedgerBalance,
  LedgerEntry,
  LedgerEntryDraft,
  LedgerImbalance,
  LedgerPostOutcome,
  LedgerTrustedState,
} from '../../domain/ledger/ledger.types.js';

/**
 * The append-only double-entry ledger (immudb in production, `InMemoryLedger` in tests). Every
 * tenant read takes the tenant explicitly; cross-tenant reads (`findUnbalanced`,
 * `totalsByCurrency`, `findMutations`) are reconciliation-only (system context, wave 2).
 */
export abstract class LedgerPort {
  /** Validates (`assertBalanced`) before any I/O; idempotent by `ledgerEntryId(sourceKey)`. */
  abstract post(draft: LedgerEntryDraft): Promise<LedgerPostOutcome>;
  abstract getEntry(tenantId: string, entryId: string): Promise<LedgerEntry | null>;
  abstract balances(tenantId: string, currency?: string): Promise<readonly LedgerBalance[]>;
  abstract findUnbalanced(window: {
    fromUs: bigint;
    toUs: bigint;
  }): Promise<readonly LedgerImbalance[]>;
  abstract totalsByCurrency(): Promise<
    readonly { currency: string; debit: bigint; credit: bigint }[]
  >;
  abstract findMutations(): Promise<readonly { table: string; id: string; rev: bigint }[]>;
  /** @throws LedgerVerificationFailedException */
  abstract verifyEntry(
    entryId: string,
    expectedPayloadHash: string,
    trusted: LedgerTrustedState,
  ): Promise<void>;
  /** @throws LedgerVerificationFailedException when the store is not consistent with `trusted`. */
  abstract advanceTrustedState(trusted: LedgerTrustedState | null): Promise<LedgerTrustedState>;
}

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
  /**
   * The store's current state as it reports it, NOT verified (R5 reads the database it names and
   * its tx id for `ledger_unverified_tx_lag`; `advanceTrustedState` is what proves a state).
   */
  abstract currentState(): Promise<LedgerTrustedState>;
  /**
   * The current state, proven to extend `trusted` (dual proof) and, when a server signing key is
   * pinned, carrying a valid signature. `trusted === null` (first use): the state is taken on
   * trust, its signature still checked when a key is pinned.
   * @throws LedgerVerificationFailedException when the store is not consistent with `trusted`,
   *   or the signature does not verify.
   */
  abstract advanceTrustedState(trusted: LedgerTrustedState | null): Promise<LedgerTrustedState>;
  /**
   * The current state, its signature verified against the server signing key the client pins
   * (audit fixes OPS-1: the re-anchor never takes a state on trust). Refused without a pinned key,
   * whatever `LEDGER_ALLOW_UNVERIFIED` says.
   * @throws LedgerSigningKeyNotPinnedException when the client pins no key (before any call)
   * @throws LedgerVerificationFailedException when the signature does not verify
   */
  abstract signedState(): Promise<LedgerTrustedState>;
}

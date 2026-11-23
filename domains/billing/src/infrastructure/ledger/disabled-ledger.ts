import { LedgerPort } from '../../application/ports/ledger.port.js';
import { LedgerDisabledException } from '../../domain/billing.errors.js';
import type {
  LedgerBalance,
  LedgerEntry,
  LedgerImbalance,
  LedgerPostOutcome,
  LedgerTrustedState,
} from '../../domain/ledger/ledger.types.js';

/**
 * `LedgerPort` while `LEDGER_ENABLED=false` (`BillingLedgerModule`): no immudb client exists, and
 * every call rejects with `LedgerDisabledException` (`LEDGER_DISABLED`, 503).
 */
export class DisabledLedger extends LedgerPort {
  override post(): Promise<LedgerPostOutcome> {
    return disabled();
  }

  override getEntry(): Promise<LedgerEntry | null> {
    return disabled();
  }

  override balances(): Promise<readonly LedgerBalance[]> {
    return disabled();
  }

  override findUnbalanced(): Promise<readonly LedgerImbalance[]> {
    return disabled();
  }

  override totalsByCurrency(): Promise<
    readonly { currency: string; debit: bigint; credit: bigint }[]
  > {
    return disabled();
  }

  override findMutations(): Promise<readonly { table: string; id: string; rev: bigint }[]> {
    return disabled();
  }

  override verifyEntry(): Promise<void> {
    return disabled();
  }

  override currentState(): Promise<LedgerTrustedState> {
    return disabled();
  }

  override advanceTrustedState(): Promise<LedgerTrustedState> {
    return disabled();
  }

  override signedState(): Promise<LedgerTrustedState> {
    return disabled();
  }
}

function disabled(): Promise<never> {
  return Promise.reject(new LedgerDisabledException());
}

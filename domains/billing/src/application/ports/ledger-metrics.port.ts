import type { LedgerPostOutcome } from '../../domain/ledger/ledger.types.js';
import type { LedgerDiscrepancyKind } from '../../domain/ledger/ledger-discrepancy.js';

/**
 * The ledger's Prometheus series as the posting and reconciliation handlers record them. Bound to
 * `LedgerMetrics` (infrastructure/ledger/ledger-metrics.ts, which names the series) by
 * `BillingLedgerModule`. Labels carry no tenant, user or amount.
 */
export abstract class LedgerMetricsPort {
  /** One `LedgerPort.post` outcome. */
  abstract posted(outcome: LedgerPostOutcome['status']): void;
  /** Starts timing one `LedgerPort.post`; call the result when it settled. */
  abstract startPost(): () => void;
  /** `count` new discrepancy rows of `kind` (0 adds nothing; 1 when omitted). */
  abstract discrepancies(kind: LedgerDiscrepancyKind, count?: number): void;
  /** The tx id of the trusted state Postgres holds (R5 reads or advances it). */
  abstract verifiedTxId(txId: bigint): void;
  /** How far the store's current tx id is past the trusted state (never below 0). */
  abstract unverifiedTxLag(currentTxId: bigint, trustedTxId: bigint): void;
  /** One finished reconciliation run; a succeeded one also stamps the last-success time. */
  abstract reconciliationRun(status: 'succeeded' | 'failed', at: Date): void;
}

import {
  getOrCreateCounter,
  getOrCreateGauge,
  getOrCreateHistogram,
} from '@platform/observability';
import type { LedgerPostOutcome } from '../../domain/ledger/ledger.types.js';
import type { LedgerDiscrepancyKind } from '../../domain/ledger/ledger-discrepancy.js';

export const LEDGER_POSTINGS_TOTAL = 'ledger_postings_total';
export const LEDGER_POST_DURATION_SECONDS = 'ledger_post_duration_seconds';
export const LEDGER_DISCREPANCIES_TOTAL = 'ledger_discrepancies_total';
export const LEDGER_RECONCILIATION_RUNS_TOTAL = 'ledger_reconciliation_runs_total';
export const LEDGER_RECONCILIATION_LAST_SUCCESS =
  'ledger_reconciliation_last_success_timestamp_seconds';
export const LEDGER_VERIFIED_TX_ID = 'ledger_verified_tx_id';
export const LEDGER_UNVERIFIED_TX_LAG = 'ledger_unverified_tx_lag';

/** `LedgerPort.post` latency buckets: one immudb read-write transaction, retried on a conflict. */
export const LEDGER_POST_DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

const postings = () =>
  getOrCreateCounter({
    name: LEDGER_POSTINGS_TOTAL,
    help: 'Ledger entries the posting consumer posted, by outcome (posted, replayed, conflict)',
    labelNames: ['outcome'],
  });

const postDuration = () =>
  getOrCreateHistogram({
    name: LEDGER_POST_DURATION_SECONDS,
    help: 'Seconds one LedgerPort.post took (validation, the immudb transaction and its retries)',
    buckets: LEDGER_POST_DURATION_BUCKETS,
  });

const discrepancies = () =>
  getOrCreateCounter({
    name: LEDGER_DISCREPANCIES_TOTAL,
    help: 'New ledger discrepancy rows, by kind (an identical finding already stored is not counted)',
    labelNames: ['kind'],
  });

const reconciliationRuns = () =>
  getOrCreateCounter({
    name: LEDGER_RECONCILIATION_RUNS_TOTAL,
    help: 'Finished ledger reconciliation runs, by status (succeeded, failed)',
    labelNames: ['status'],
  });

const reconciliationLastSuccess = () =>
  getOrCreateGauge({
    name: LEDGER_RECONCILIATION_LAST_SUCCESS,
    help: 'Unix time (seconds) the last ledger reconciliation run succeeded',
  });

const verifiedTxId = () =>
  getOrCreateGauge({
    name: LEDGER_VERIFIED_TX_ID,
    help: 'immudb tx id of the trusted ledger state stored in Postgres (R5)',
  });

const unverifiedTxLag = () =>
  getOrCreateGauge({
    name: LEDGER_UNVERIFIED_TX_LAG,
    help: 'immudb transactions past the trusted ledger state, not yet proven (R5)',
  });

/**
 * The ledger's Prometheus series (prom-client's default registry through GM's `getOrCreate*`, so
 * several apps in one process share them). Labels carry no tenant, user or amount.
 */
export const LedgerMetrics = Object.freeze({
  /** One `LedgerPort.post` outcome. */
  posted(outcome: LedgerPostOutcome['status']): void {
    postings().inc({ outcome });
  },

  /** Starts timing one `LedgerPort.post`; call the result when it settled. */
  startPost(): () => void {
    const end = postDuration().startTimer();
    return () => {
      end();
    };
  },

  /** `count` new discrepancy rows of `kind` (0 adds nothing). */
  discrepancies(kind: LedgerDiscrepancyKind, count = 1): void {
    if (count > 0) discrepancies().inc({ kind }, count);
  },

  /** The tx id of the trusted state Postgres holds (R5 reads or advances it). */
  verifiedTxId(txId: bigint): void {
    verifiedTxId().set(Number(txId));
  },

  /** How far the store's current tx id is past the trusted state (never below 0). */
  unverifiedTxLag(currentTxId: bigint, trustedTxId: bigint): void {
    const lag = currentTxId - trustedTxId;
    unverifiedTxLag().set(lag > 0n ? Number(lag) : 0);
  },

  /** One finished reconciliation run; a succeeded one also stamps the last-success time. */
  reconciliationRun(status: 'succeeded' | 'failed', at: Date): void {
    reconciliationRuns().inc({ status });
    if (status === 'succeeded') reconciliationLastSuccess().set(at.getTime() / 1_000);
  },
});

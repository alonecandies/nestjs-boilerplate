import { Command } from '@nestjs/cqrs';
import type { LedgerRunOutcome } from '../reconcile-ledger/reconcile-ledger.command.js';

/** What the operator gives the ledger-reanchor CLI (every field required). */
export interface LedgerReanchorRequest {
  /** The immudb database whose trusted state is replaced: the one the store names. */
  readonly database: string;
  /**
   * Where the lost history starts (the restore point). Inside the last 15 minutes (the cron's
   * grace) the re-anchor skips its follow-up run and `--reconcile-only` is refused.
   */
  readonly lostFrom: Date;
  /** Who runs it (stored in the audit row). */
  readonly operator: string;
  /** Why (stored in the audit row). */
  readonly reason: string;
}

/**
 * The follow-up run a re-anchor skipped (audit batch 1, Task 39): its lost-from is inside the
 * cron's 15-minute grace, so `[lostFrom, now − 15 min)` is empty. The lost window is recent, so the
 * hourly reconciliation's own window covers it.
 */
export interface LedgerReconciliationSkipped {
  readonly status: 'skipped';
  readonly reason: 'lost-from-in-grace';
}

/** A re-anchor that happened: its audit row, the states and the follow-up reconciliation. */
export interface LedgerReanchorResult {
  readonly reanchorId: string;
  readonly database: string;
  /** The tx id of the trusted state it replaced. */
  readonly replacedTxId: bigint;
  /** The tx id of the restored server's state it stored. */
  readonly txId: bigint;
  /**
   * The run over `[lostFrom, now − 15 min)`: its id, status, failed checks and counts; or, with a
   * lost-from inside that grace, the skipped run (the hourly reconciliation covers the window).
   */
  readonly reconciliation: LedgerRunOutcome | LedgerReconciliationSkipped;
}

/** A re-run of the reconciliation over the lost window (`--reconcile-only`): no re-anchor. */
export interface LedgerReconcileOnlyResult {
  readonly database: string;
  /** The run over `[lostFrom, now − 15 min)`: its id, status, failed checks and counts. */
  readonly reconciliation: LedgerRunOutcome;
}

/**
 * The audited re-anchor of `billing.ledger_trusted_state` after an immudb restore (audit fixes
 * OPS-1). Dispatched only by the ledger-reanchor CLI (`runLedgerReanchorCli`), inside
 * `SystemContext`: its handler is registered by `BillingLedgerReanchorModule`, which no running
 * app imports. See `ReanchorLedgerHandler` for the refusals and the writes.
 */
export class ReanchorLedgerCommand extends Command<LedgerReanchorResult> {
  constructor(readonly request: LedgerReanchorRequest) {
    super();
  }
}

/**
 * The ledger-reanchor CLI's `--reconcile-only` mode (audit batch 1 review #2): one
 * `ReconcileLedgerCommand` over `[lostFrom, now − 15 min)` again (the cron's grace), without
 * re-anchoring and without an audit row, for a lost window older than the cron's lookback whose
 * follow-up run failed. Refused while the trusted state still needs a re-anchor, and while the
 * lost-from is inside the grace (nothing to reconcile yet: retry once it is older). Dispatched only
 * by `runLedgerReanchorCli`, inside `SystemContext`; see `RerunLedgerReconciliationHandler`.
 */
export class RerunLedgerReconciliationCommand extends Command<LedgerReconcileOnlyResult> {
  constructor(readonly request: LedgerReanchorRequest) {
    super();
  }
}

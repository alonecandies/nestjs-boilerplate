import { Command } from '@nestjs/cqrs';
import type {
  LedgerDetector,
  LedgerDiscrepancyInput,
} from '../../../domain/ledger/ledger-discrepancy.js';
import type { LedgerRunCounts } from '../../repositories/ledger.system-repository.js';

/** The half-open window `[from, to)` one reconciliation run looks at. */
export interface LedgerReconcileWindow {
  readonly from: Date;
  readonly to: Date;
}

/**
 * One reconciliation run (ledger design §4, outbox plan Task 15): every registered check over the
 * window, its findings appended to `billing.ledger_discrepancies`; nothing is ever corrected.
 * Without `window`: `[now − grace − LEDGER_RECONCILE_LOOKBACK_HOURS, now − grace)`. Runs only
 * inside `SystemContext` (`ReconcileLedgerCron`, or a backfill with an explicit window); resolves
 * with the run's counts.
 */
export class ReconcileLedgerCommand extends Command<LedgerRunCounts> {
  /** @throws RangeError when `window.from` is not before `window.to` */
  constructor(readonly window?: LedgerReconcileWindow) {
    super();
    if (window !== undefined && !(window.from.getTime() < window.to.getTime())) {
      throw new RangeError('a reconciliation window needs from < to');
    }
  }
}

/** What a check sees of its run. */
export interface ReconciliationContext {
  readonly runId: string;
  readonly from: Date;
  readonly to: Date;
}

/**
 * One reconciliation check (R1-R5). `run` returns its findings, each carrying `detectedBy: name`
 * and the run id, and writes no discrepancy: the handler appends them. A check that throws fails
 * the run after the other checks ran (a `ReconciliationCheckFailure`'s findings are appended all
 * the same). R5 is the one check that writes something else: the trusted state.
 */
export interface ReconciliationCheck {
  readonly name: Exclude<LedgerDetector, 'consumer'>;
  run(ctx: ReconciliationContext): Promise<readonly LedgerDiscrepancyInput[]>;
}

/**
 * Thrown by a check whose run must finish `failed` although it has findings to store (R5: a failed
 * proof is a finding AND a failed run). The handler appends `findings` first, then counts the check
 * as failed like any other throwing check.
 */
export class ReconciliationCheckFailure extends Error {
  override readonly name = 'ReconciliationCheckFailure';

  constructor(
    message: string,
    readonly findings: readonly LedgerDiscrepancyInput[] = [],
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
  }
}

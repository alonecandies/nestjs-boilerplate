import { Command } from '@nestjs/cqrs';
import type {
  LedgerDetector,
  LedgerDiscrepancyInput,
} from '../../../domain/ledger/ledger-discrepancy.js';
import type { LedgerRunCounts } from '../../repositories/ledger.system-repository.js';
import type { LedgerEntryRef } from '../../repositories/ledger-receipts.repository.js';

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

/** One run's read of the ledger refs (`ReconciliationContext.entryRefs`). */
export interface RunEntryRefs {
  /** When the read started: every row was posted before it. */
  readonly readAt: Date;
  /** The refs of all tenants posted from the read's start until `readAt`. */
  readonly rows: readonly LedgerEntryRef[];
}

/**
 * What a check sees of its run: one object per run, the same for every check. `entryRefs` reads
 * the refs of all tenants posted in `[from − 24 h, now)` on its first call and resolves with that
 * same read on later ones (a failed read is not kept: the next call reads again). R3 calls it
 * first and filters to its own window; R4 reuses it and lists only the refs posted since its
 * `readAt`. R5 keeps its own listing. Without it (a check run on its own), R3 and R4 read their
 * own refs.
 */
export interface ReconciliationContext {
  readonly runId: string;
  readonly from: Date;
  readonly to: Date;
  readonly entryRefs?: () => Promise<RunEntryRefs>;
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

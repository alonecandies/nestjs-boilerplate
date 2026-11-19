import { Inject, Logger } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { generateId, SystemContext } from '@platform/common';
import { SystemDatabaseError } from '@platform/database';
import { LEDGER_RECONCILE_GRACE_MS } from '../../../billing.constants.js';
import type { LedgerDiscrepancyKind } from '../../../domain/ledger/ledger-discrepancy.js';
import { type LedgerConfig, ledgerConfig } from '../../../infrastructure/ledger/ledger.config.js';
import { LedgerMetrics } from '../../../infrastructure/ledger/ledger-metrics.js';
import {
  type LedgerRunCounts,
  LedgerSystemRepository,
} from '../../repositories/ledger.system-repository.js';
import { R1InvariantCheck } from './checks/r1-invariant.js';
import { R2MutationCheck } from './checks/r2-mutation.js';
import { R3PaymentsCheck } from './checks/r3-payments.js';
import { R4StripeCheck } from './checks/r4-stripe.js';
import {
  type LedgerReconcileWindow,
  ReconcileLedgerCommand,
  type ReconciliationCheck,
} from './reconcile-ledger.command.js';

const HOUR_MS = 3_600_000;

/** The default window at `now`: `[to − lookback, to)` with `to = now − LEDGER_RECONCILE_GRACE_MS`. */
export function defaultReconcileWindow(now: Date, lookbackHours: number): LedgerReconcileWindow {
  const to = new Date(now.getTime() - LEDGER_RECONCILE_GRACE_MS);
  return { from: new Date(to.getTime() - lookbackHours * HOUR_MS), to };
}

/**
 * One reconciliation run (ledger design §4; outbox plan Task 15): `startRun` → every registered
 * check in order (R1, R2, R3, R4; Task 17 adds R5), each check's findings appended with
 * `appendDiscrepancies` (one call per kind, so the new rows are known per kind) → `finishRun`.
 * Findings are only appended, never corrected; their ids are deterministic, so a rerun or an
 * overlapping window adds no row. A check that throws (or whose findings cannot be stored) is
 * logged, the remaining checks still run, rows already appended stay, and the run finishes
 * `failed`. `found` counts findings per kind, `appended` the new rows among them; the metrics
 * count new rows only. Runs only inside `SystemContext` (`SYSTEM_CONTEXT_REQUIRED` otherwise,
 * before anything is read or written).
 */
@CommandHandler(ReconcileLedgerCommand)
export class ReconcileLedgerHandler implements ICommandHandler<ReconcileLedgerCommand> {
  private readonly logger = new Logger(ReconcileLedgerHandler.name);
  readonly checks: readonly ReconciliationCheck[];

  constructor(
    @Inject(ledgerConfig.KEY) private readonly config: LedgerConfig,
    private readonly system: LedgerSystemRepository,
    r1: R1InvariantCheck,
    r2: R2MutationCheck,
    r3: R3PaymentsCheck,
    r4: R4StripeCheck,
  ) {
    this.checks = [r1, r2, r3, r4];
  }

  async execute(command: ReconcileLedgerCommand): Promise<LedgerRunCounts> {
    if (!SystemContext.isActive()) {
      throw new SystemDatabaseError(
        'SYSTEM_CONTEXT_REQUIRED',
        'ReconcileLedgerCommand runs only inside SystemContext.run()',
      );
    }
    const window =
      command.window ?? defaultReconcileWindow(new Date(), this.config.reconcileLookbackHours);
    const runId = generateId();
    await this.system.startRun({ id: runId, ...window });

    const found: Partial<Record<LedgerDiscrepancyKind, number>> = {};
    const appended: Partial<Record<LedgerDiscrepancyKind, number>> = {};
    const failedChecks: string[] = [];
    for (const check of this.checks) {
      try {
        const findings = await check.run({ runId, ...window });
        for (const [kind, rows] of Map.groupBy(findings, (row) => row.kind)) {
          found[kind] = (found[kind] ?? 0) + rows.length;
          const added = await this.system.appendDiscrepancies(rows);
          appended[kind] = (appended[kind] ?? 0) + added;
          LedgerMetrics.discrepancies(kind, added);
        }
      } catch (error) {
        failedChecks.push(check.name);
        this.logger.error({ err: error, runId, check: check.name }, 'Reconciliation check failed');
      }
    }

    const counts: LedgerRunCounts = { found, appended };
    const status = failedChecks.length === 0 ? 'succeeded' : 'failed';
    await this.system.finishRun(runId, status, counts);
    LedgerMetrics.reconciliationRun(status, new Date());
    this.logger.log(
      { runId, from: window.from, to: window.to, status, failedChecks, counts },
      'Ledger reconciliation run finished',
    );
    return counts;
  }
}

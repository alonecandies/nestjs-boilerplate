import { Inject, Injectable, Logger } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SystemContext } from '@platform/common';
import { WithLock } from '@platform/redis';
import { ReconcileLedgerCommand } from '../../application/commands/reconcile-ledger/reconcile-ledger.command.js';
import type { LedgerRunCounts } from '../../application/repositories/ledger.system-repository.js';
import { RECONCILE_LEDGER_LOCK, RECONCILE_LEDGER_LOCK_TTL_MS } from '../../billing.constants.js';
import { type LedgerConfig, ledgerConfig } from '../ledger/ledger.config.js';

/** The cron's name, and the system context its run happens in. */
const RECONCILE_LEDGER_JOB = 'billing.reconcile-ledger';

/**
 * Hourly ledger reconciliation (ledger design §4, outbox plan Task 15): one
 * `ReconcileLedgerCommand` over the default overlapping window. `@Cron` fires on every replica;
 * `@WithLock` (Redis redlock, auto-extended while running) lets exactly one of them run it. The run
 * is principal-less and crosses tenants, so the command is dispatched inside
 * `SystemContext.run('billing.reconcile-ledger')`, opened here at the scheduled entry point and
 * never in the handler. With `LEDGER_ENABLED=false` it does nothing (no lock, no command). It never
 * throws into the scheduler: a failed run is logged and the next tick tries again.
 */
@Injectable()
export class ReconcileLedgerCron {
  private readonly logger = new Logger(ReconcileLedgerCron.name);

  constructor(
    private readonly commandBus: CommandBus,
    @Inject(ledgerConfig.KEY) private readonly config: LedgerConfig,
  ) {}

  @Cron(CronExpression.EVERY_HOUR, {
    name: RECONCILE_LEDGER_JOB,
    timeZone: 'UTC',
    waitForCompletion: true,
  })
  async run(): Promise<void> {
    if (!this.config.enabled) return;
    try {
      await this.reconcile();
    } catch (error) {
      this.logger.error({ err: error }, 'Ledger reconciliation failed');
    }
  }

  /** The run itself, on the replica that holds the lock (the others resolve without running). */
  @WithLock(RECONCILE_LEDGER_LOCK, RECONCILE_LEDGER_LOCK_TTL_MS)
  private async reconcile(): Promise<void> {
    const counts: LedgerRunCounts = await SystemContext.run(RECONCILE_LEDGER_JOB, () =>
      this.commandBus.execute(new ReconcileLedgerCommand()),
    );
    this.logger.log({ counts }, 'Ledger reconciliation finished');
  }
}

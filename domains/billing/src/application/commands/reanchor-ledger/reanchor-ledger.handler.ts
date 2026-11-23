import { Inject, Logger } from '@nestjs/common';
import { CommandBus, CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { generateId, SystemContext } from '@platform/common';
import { SystemDatabaseError } from '@platform/database';
import {
  LedgerReanchorRefusedException,
  LedgerSigningKeyNotPinnedException,
  LedgerVerificationFailedException,
} from '../../../domain/ledger/ledger.errors.js';
import type { LedgerTrustedState } from '../../../domain/ledger/ledger.types.js';
import { type LedgerConfig, ledgerConfig } from '../../../infrastructure/ledger/ledger.config.js';
import { LedgerPort } from '../../ports/ledger.port.js';
import { LedgerSystemRepository } from '../../repositories/ledger.system-repository.js';
import {
  type LedgerRunOutcome,
  ReconcileLedgerCommand,
} from '../reconcile-ledger/reconcile-ledger.command.js';
import {
  type LedgerReanchorRequest,
  type LedgerReanchorResult,
  type LedgerReconcileOnlyResult,
  ReanchorLedgerCommand,
  RerunLedgerReconciliationCommand,
} from './reanchor-ledger.command.js';

/** The refusals both commands share: outside `SystemContext`, the ledger off, a future lost-from. */
function assertCanRun(
  command: string,
  config: LedgerConfig,
  lostFrom: Date,
  now: Date = new Date(),
): void {
  if (!SystemContext.isActive()) {
    throw new SystemDatabaseError(
      'SYSTEM_CONTEXT_REQUIRED',
      `${command} runs only inside SystemContext.run()`,
    );
  }
  if (!config.enabled) {
    throw new LedgerReanchorRefusedException(
      'ledger-disabled',
      'the ledger is off (LEDGER_ENABLED=false): there is no trusted state to re-anchor',
    );
  }
  if (!(lostFrom.getTime() < now.getTime())) {
    throw new LedgerReanchorRefusedException(
      'lost-from-not-past',
      `--lost-from ${lostFrom.toISOString()} is not in the past`,
    );
  }
}

/** Whether the current state is proven (dual proof) to extend `trusted`. */
async function extendsTrusted(ledger: LedgerPort, trusted: LedgerTrustedState): Promise<boolean> {
  try {
    await ledger.advanceTrustedState(trusted);
    return true;
  } catch (error) {
    // Only a failed proof means "does not extend"; a transport error propagates.
    if (error instanceof LedgerVerificationFailedException) return false;
    throw error;
  }
}

/**
 * One `ReconcileLedgerCommand` over `[lostFrom, now)`, resolving with how the run finished (its
 * status and failed checks, from the command's `onFinished`).
 */
async function reconcileLostWindow(
  commands: CommandBus,
  lostFrom: Date,
): Promise<LedgerRunOutcome> {
  const finished: { outcome?: LedgerRunOutcome } = {};
  await commands.execute(
    new ReconcileLedgerCommand({ from: lostFrom, to: new Date() }, (outcome) => {
      finished.outcome = outcome;
    }),
  );
  if (finished.outcome === undefined) {
    throw new Error('the reconciliation run over the lost window reported no outcome');
  }
  return finished.outcome;
}

/**
 * The audited re-anchor (audit fixes OPS-1). In this order it refuses, writing nothing, with
 * `LedgerReanchorRefusedException` naming why:
 * 1. `ledger-disabled`: `LEDGER_ENABLED=false`;
 * 2. `lost-from-not-past`: the lost history would start now or later;
 * 3. `signing-key-not-pinned`: the client pins no server signing key (`LedgerPort.signedState`;
 *    `LEDGER_ALLOW_UNVERIFIED` does not help);
 * 4. `signature-invalid`: the restored server's current state is not signed by that key;
 * 5. `other-database`: `--database` is not the database the store names;
 * 6. `no-trusted-state`: nothing stored to replace (R5 stores the first state itself);
 * 7. `nothing-lost`: the current state still extends the trusted one (dual proof): R5 advances it;
 * 8. `trusted-state-changed`: the stored state changed meanwhile (the compare-and-set lost).
 * Otherwise `LedgerSystemRepository.reanchorTrustedState` writes the audit row and replaces the
 * stored state with exactly the state whose signature was verified, `lostFrom` as its read time,
 * in one transaction; then one `ReconcileLedgerCommand` over `[lostFrom, now)` runs: R4 re-enqueues
 * what Stripe lists there and the ledger lacks, R5 reports each lost entry as `verification_failed`
 * (until the posting path posts it again); the result carries that run's status and failed checks
 * (a failed run is not an error here: the re-anchor committed). Only an `LedgerVerificationFailedException` of the dual
 * proof means "does not extend"; any other failure (a transport error) propagates. Runs only inside
 * `SystemContext` (the CLI opens it). Registered by `BillingLedgerReanchorModule` alone.
 */
@CommandHandler(ReanchorLedgerCommand)
export class ReanchorLedgerHandler implements ICommandHandler<ReanchorLedgerCommand> {
  private readonly logger = new Logger(ReanchorLedgerHandler.name);

  constructor(
    @Inject(ledgerConfig.KEY) private readonly config: LedgerConfig,
    private readonly ledger: LedgerPort,
    private readonly system: LedgerSystemRepository,
    private readonly commands: CommandBus,
  ) {}

  async execute({ request }: ReanchorLedgerCommand): Promise<LedgerReanchorResult> {
    const { database, lostFrom, operator, reason } = request;
    assertCanRun('ReanchorLedgerCommand', this.config, lostFrom);

    const state = await this.signedState();
    if (state.database !== database) {
      throw new LedgerReanchorRefusedException(
        'other-database',
        `--database ${database} is not the ledger's database (${state.database})`,
      );
    }
    const stored = await this.system.readTrustedState(database);
    if (stored === null) {
      throw new LedgerReanchorRefusedException(
        'no-trusted-state',
        `no trusted state is stored for ${database}: the next reconciliation stores the first one`,
      );
    }
    const trusted: LedgerTrustedState = { database, txId: stored.txId, txHash: stored.txHash };
    if (await extendsTrusted(this.ledger, trusted)) {
      throw new LedgerReanchorRefusedException(
        'nothing-lost',
        `the ledger state of ${database} still extends the trusted one (tx ${trusted.txId}): ` +
          'nothing was lost, reconciliation advances it',
      );
    }

    const reanchorId = generateId();
    const written = await this.system.reanchorTrustedState({
      id: reanchorId,
      database,
      from: trusted,
      to: state,
      lostFrom,
      operator,
      reason,
    });
    if (!written) {
      throw new LedgerReanchorRefusedException(
        'trusted-state-changed',
        `the trusted state of ${database} changed during the re-anchor: run it again`,
      );
    }
    this.logger.warn(
      {
        reanchorId,
        database,
        replacedTxId: trusted.txId.toString(),
        txId: state.txId.toString(),
        lostFrom,
      },
      'Ledger trusted state re-anchored after a restore',
    );

    const reconciliation = await reconcileLostWindow(this.commands, lostFrom);
    return { reanchorId, database, replacedTxId: trusted.txId, txId: state.txId, reconciliation };
  }

  /** The restored server's current state, its signature verified against the pinned key. */
  private async signedState(): Promise<LedgerTrustedState> {
    try {
      return await this.ledger.signedState();
    } catch (error) {
      if (error instanceof LedgerSigningKeyNotPinnedException) {
        throw new LedgerReanchorRefusedException('signing-key-not-pinned', error.message, {
          cause: error,
        });
      }
      if (error instanceof LedgerVerificationFailedException) {
        throw new LedgerReanchorRefusedException(
          'signature-invalid',
          `the ledger state does not verify against the pinned key: ${error.reason}`,
          { cause: error },
        );
      }
      throw error;
    }
  }
}

/**
 * The `--reconcile-only` re-run (audit batch 1 review #2): one `ReconcileLedgerCommand` over
 * `[lostFrom, now)` again, for a lost window whose follow-up run failed (or is older than the
 * cron's lookback). It writes no audit row and leaves the trusted state to R5. In this order it
 * refuses, reconciling nothing: `ledger-disabled`; `lost-from-not-past`; `other-database`
 * (`--database` is not the database the store names); `reanchor-needed` (a trusted state is stored
 * and the current state is not proven to extend it: re-anchor first). With no stored state it runs
 * (R5 stores the first one). A transport error of the proof propagates. Runs only inside
 * `SystemContext`; registered by `BillingLedgerReanchorModule` alone, next to the re-anchor.
 */
@CommandHandler(RerunLedgerReconciliationCommand)
export class RerunLedgerReconciliationHandler
  implements ICommandHandler<RerunLedgerReconciliationCommand>
{
  private readonly logger = new Logger(RerunLedgerReconciliationHandler.name);

  constructor(
    @Inject(ledgerConfig.KEY) private readonly config: LedgerConfig,
    private readonly ledger: LedgerPort,
    private readonly system: LedgerSystemRepository,
    private readonly commands: CommandBus,
  ) {}

  async execute({ request }: RerunLedgerReconciliationCommand): Promise<LedgerReconcileOnlyResult> {
    const { database, lostFrom, operator, reason }: LedgerReanchorRequest = request;
    assertCanRun('RerunLedgerReconciliationCommand', this.config, lostFrom);

    // The database name only: the extension proof below is what checks the state.
    const current = await this.ledger.currentState();
    if (current.database !== database) {
      throw new LedgerReanchorRefusedException(
        'other-database',
        `--database ${database} is not the ledger's database (${current.database})`,
      );
    }
    const stored = await this.system.readTrustedState(database);
    if (stored !== null) {
      const trusted: LedgerTrustedState = { database, txId: stored.txId, txHash: stored.txHash };
      if (!(await extendsTrusted(this.ledger, trusted))) {
        throw new LedgerReanchorRefusedException(
          'reanchor-needed',
          `the ledger state of ${database} does not extend the trusted one (tx ${trusted.txId}): ` +
            're-anchor it first (without --reconcile-only)',
        );
      }
    }

    this.logger.warn(
      { database, lostFrom, operator, reason },
      'Ledger reconciliation re-run over the lost window (no re-anchor)',
    );
    const reconciliation = await reconcileLostWindow(this.commands, lostFrom);
    return { database, reconciliation };
  }
}

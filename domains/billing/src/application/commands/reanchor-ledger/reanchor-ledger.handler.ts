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
import { ReconcileLedgerCommand } from '../reconcile-ledger/reconcile-ledger.command.js';
import { type LedgerReanchorResult, ReanchorLedgerCommand } from './reanchor-ledger.command.js';

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
 * (until the posting path posts it again). Only an `LedgerVerificationFailedException` of the dual
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
    if (!SystemContext.isActive()) {
      throw new SystemDatabaseError(
        'SYSTEM_CONTEXT_REQUIRED',
        'ReanchorLedgerCommand runs only inside SystemContext.run()',
      );
    }
    const { database, lostFrom, operator, reason } = request;
    if (!this.config.enabled) {
      throw new LedgerReanchorRefusedException(
        'ledger-disabled',
        'the ledger is off (LEDGER_ENABLED=false): there is no trusted state to re-anchor',
      );
    }
    const now = new Date();
    if (!(lostFrom.getTime() < now.getTime())) {
      throw new LedgerReanchorRefusedException(
        'lost-from-not-past',
        `--lost-from ${lostFrom.toISOString()} is not in the past`,
      );
    }

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
    if (await this.extendsTrusted(trusted)) {
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

    const reconciliation = await this.commands.execute(
      new ReconcileLedgerCommand({ from: lostFrom, to: new Date() }),
    );
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

  /** Whether the current state is proven (dual proof) to extend `trusted`. */
  private async extendsTrusted(trusted: LedgerTrustedState): Promise<boolean> {
    try {
      await this.ledger.advanceTrustedState(trusted);
      return true;
    } catch (error) {
      if (error instanceof LedgerVerificationFailedException) return false;
      throw error;
    }
  }
}

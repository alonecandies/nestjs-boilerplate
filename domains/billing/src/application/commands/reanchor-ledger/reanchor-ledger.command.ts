import { Command } from '@nestjs/cqrs';
import type { LedgerRunCounts } from '../../repositories/ledger.system-repository.js';

/** What the operator gives the ledger-reanchor CLI (every field required). */
export interface LedgerReanchorRequest {
  /** The immudb database whose trusted state is replaced: the one the store names. */
  readonly database: string;
  /** Where the lost history starts (the restore point); must be in the past. */
  readonly lostFrom: Date;
  /** Who runs it (stored in the audit row). */
  readonly operator: string;
  /** Why (stored in the audit row). */
  readonly reason: string;
}

/** A re-anchor that happened: its audit row, the states and the follow-up reconciliation. */
export interface LedgerReanchorResult {
  readonly reanchorId: string;
  readonly database: string;
  /** The tx id of the trusted state it replaced. */
  readonly replacedTxId: bigint;
  /** The tx id of the restored server's state it stored. */
  readonly txId: bigint;
  /** The counts of the reconciliation run over `[lostFrom, now)`. */
  readonly reconciliation: LedgerRunCounts;
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

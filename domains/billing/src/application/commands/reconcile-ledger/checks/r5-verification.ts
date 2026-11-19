import { Injectable, Logger } from '@nestjs/common';
import { PLATFORM_TENANT_ID, SystemContext } from '@platform/common';
import { SystemDatabaseError } from '@platform/database';
import { LedgerVerificationFailedException } from '../../../../domain/ledger/ledger.errors.js';
import type { LedgerTrustedState } from '../../../../domain/ledger/ledger.types.js';
import type { LedgerDiscrepancyInput } from '../../../../domain/ledger/ledger-discrepancy.js';
import { LedgerMetrics } from '../../../../infrastructure/ledger/ledger-metrics.js';
import { LedgerPort } from '../../../ports/ledger.port.js';
import {
  type LedgerCursor,
  LedgerSystemRepository,
} from '../../../repositories/ledger.system-repository.js';
import type { LedgerEntryRef } from '../../../repositories/ledger-receipts.repository.js';
import {
  type ReconciliationCheck,
  ReconciliationCheckFailure,
  type ReconciliationContext,
} from '../reconcile-ledger.command.js';

/** Page size of the ref list. */
export const R5_REF_PAGE_SIZE = 500;

/**
 * How far before the stored `verifiedAt` a run looks for refs the last run could not see. A ref is
 * written to Postgres after its immudb post, so one whose tx the stored state includes may land
 * after that run read the state; the last run's read happened before `verifiedAt` (stamped by the
 * compare-and-set after the proof), and this margin covers the proof's duration and the clock skew
 * between the database (`verified_at`) and the consumers (`posted_at`).
 */
export const R5_VERIFIED_AT_OVERLAP_MS = 10 * 60_000;

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

/**
 * R5, tamper evidence (ledger design §4 R5, L-14; outbox plan Task 17), registered only while
 * `LEDGER_VERIFY=true`. In this order, with `db` the database the store names:
 * 1. `trusted = readTrustedState(db)`; `ledger_unverified_tx_lag` = current tx id − trusted tx id.
 * 2. `next = LedgerPort.advanceTrustedState(trusted)`: the dual proof from `trusted` and, when a
 *    server signing key is pinned, the state signature. No trusted row yet: the current state is
 *    taken on trust (signature still checked), with a warning. A failed proof → one
 *    `verification_failed` under the platform tenant (source key `state:<db>`), no advance, no
 *    entry verified, the run `failed` (`ReconciliationCheckFailure`).
 * 3. `advanceTrustedState(db, trusted, next)`, a compare-and-set: lost → the run `failed`, no
 *    finding, no retry, no entry verified (the run that won verifies them).
 * 4. Every ref posted from `min(from, cutoff)` until the state was read, with `cutoff` the stored
 *    `verifiedAt` − `R5_VERIFIED_AT_OVERLAP_MS`, whose tx id is above the old trusted tx id (up to
 *    `next`'s), or at most the old one and posted since `cutoff` (recorded after the last run read
 *    its state, so that run never saw it), or null (a `replayed` receipt):
 *    `LedgerPort.verifyEntry(entryId, payloadHash, next)`; a failure → `verification_failed` under
 *    the ref's tenant (source key `ledger_entries:<id>`). Entry failures do not undo step 3.
 * `ledger_verified_tx_id` follows the stored state. Runs only inside `SystemContext`.
 */
@Injectable()
export class R5VerificationCheck implements ReconciliationCheck {
  readonly name = 'R5';
  private readonly logger = new Logger(R5VerificationCheck.name);

  constructor(
    private readonly ledger: LedgerPort,
    private readonly system: LedgerSystemRepository,
  ) {}

  async run(ctx: ReconciliationContext): Promise<readonly LedgerDiscrepancyInput[]> {
    if (!SystemContext.isActive()) {
      throw new SystemDatabaseError(
        'SYSTEM_CONTEXT_REQUIRED',
        'reconciliation R5 runs only inside SystemContext.run()',
      );
    }
    const current = await this.ledger.currentState();
    const db = current.database;
    const stored = await this.system.readTrustedState(db);
    const trusted: LedgerTrustedState | null =
      stored === null ? null : { database: db, txId: stored.txId, txHash: stored.txHash };
    if (trusted !== null) LedgerMetrics.verifiedTxId(trusted.txId);
    LedgerMetrics.unverifiedTxLag(current.txId, trusted?.txId ?? 0n);

    // Every ref recorded before this instant belongs to an immudb tx the state below includes.
    const readAt = new Date();
    let next: LedgerTrustedState;
    try {
      next = await this.ledger.advanceTrustedState(trusted);
    } catch (error) {
      if (!(error instanceof LedgerVerificationFailedException)) throw error;
      throw new ReconciliationCheckFailure(
        `the ledger state of ${db} does not extend the trusted one: ${error.reason}`,
        [
          this.finding(ctx, {
            tenantId: PLATFORM_TENANT_ID,
            sourceKey: `state:${db}`,
            expected:
              trusted === null
                ? { txId: null, txHash: null }
                : { txId: trusted.txId.toString(), txHash: hex(trusted.txHash) },
            actual: { reason: error.reason },
          }),
        ],
        { cause: error },
      );
    }
    if (trusted === null) {
      this.logger.warn(
        { database: db, txId: next.txId.toString() },
        'No trusted ledger state yet: the current state is taken on trust (first use)',
      );
    }

    if (!(await this.system.advanceTrustedState(db, trusted, next))) {
      throw new ReconciliationCheckFailure(
        `the trusted ledger state of ${db} changed during the run (compare-and-set lost)`,
      );
    }
    LedgerMetrics.verifiedTxId(next.txId);
    LedgerMetrics.unverifiedTxLag(current.txId, next.txId);

    // Refs of txs the stored state includes but recorded after the last run read it: posted since
    // `cutoff`. A ref recorded later still falls in a later run's window, with its own cutoff.
    const cutoff =
      stored === null ? null : new Date(stored.verifiedAt.getTime() - R5_VERIFIED_AT_OVERLAP_MS);
    const since = cutoff === null || ctx.from.getTime() <= cutoff.getTime() ? ctx.from : cutoff;
    const oldTxId = trusted?.txId ?? 0n;
    const found: LedgerDiscrepancyInput[] = [];
    let after: LedgerCursor | null = null;
    for (;;) {
      const batch = await this.system.listEntryRefs(since, readAt, after, R5_REF_PAGE_SIZE);
      for (const ref of batch) {
        if (!needsVerification(ref, oldTxId, next.txId, cutoff)) continue;
        const failure = await this.verify(ref, next);
        if (failure !== null) found.push(this.finding(ctx, failure));
      }
      const last = batch.at(-1);
      if (last === undefined || batch.length < R5_REF_PAGE_SIZE) return found;
      after = { tenantId: last.tenantId, id: last.entryId };
    }
  }

  /** The finding of a ref whose entry does not verify against `state`; null when it does. */
  private async verify(
    ref: LedgerEntryRef,
    state: LedgerTrustedState,
  ): Promise<Omit<LedgerDiscrepancyInput, 'kind' | 'detectedBy' | 'runId'> | null> {
    try {
      await this.ledger.verifyEntry(ref.entryId, ref.payloadHash, state);
      return null;
    } catch (error) {
      if (!(error instanceof LedgerVerificationFailedException)) throw error;
      return {
        tenantId: ref.tenantId,
        sourceKey: `ledger_entries:${ref.entryId}`,
        expected: {
          entryId: ref.entryId,
          payloadHash: ref.payloadHash,
          immudbTxId: ref.immudbTxId?.toString() ?? null,
        },
        actual: { reason: error.reason },
      };
    }
  }

  private finding(
    ctx: ReconciliationContext,
    row: Omit<LedgerDiscrepancyInput, 'kind' | 'detectedBy' | 'runId'>,
  ): LedgerDiscrepancyInput {
    return { ...row, kind: 'verification_failed', detectedBy: this.name, runId: ctx.runId };
  }
}

/**
 * A ref the new state has to vouch for (a tx above the new one is verified by the next run):
 * - posted after the old trusted state (`immudbTxId` above it, up to the new one);
 * - of a tx the old state includes but recorded since `cutoff`, after the last run read its state;
 * - a `replayed` receipt without a tx id, which is verified on every run that lists it.
 */
function needsVerification(
  ref: LedgerEntryRef,
  oldTxId: bigint,
  nextTxId: bigint,
  cutoff: Date | null,
): boolean {
  if (ref.immudbTxId === null) return true;
  if (ref.immudbTxId > nextTxId) return false;
  if (ref.immudbTxId > oldTxId) return true;
  return cutoff !== null && ref.postedAt.getTime() >= cutoff.getTime();
}

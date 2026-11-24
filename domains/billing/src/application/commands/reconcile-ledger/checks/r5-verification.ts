import { Injectable, Logger } from '@nestjs/common';
import { PLATFORM_TENANT_ID, SystemContext } from '@platform/common';
import { SystemDatabaseError } from '@platform/database';
import { LedgerVerificationFailedException } from '../../../../domain/ledger/ledger.errors.js';
import type { LedgerTrustedState } from '../../../../domain/ledger/ledger.types.js';
import type { LedgerDiscrepancyInput } from '../../../../domain/ledger/ledger-discrepancy.js';
import { LedgerPort } from '../../../ports/ledger.port.js';
import { LedgerMetricsPort } from '../../../ports/ledger-metrics.port.js';
import {
  type LedgerReanchorMark,
  LedgerSystemRepository,
} from '../../../repositories/ledger.system-repository.js';
import type { LedgerEntryRef } from '../../../repositories/ledger-receipts.repository.js';
import {
  type ReconciliationCheck,
  ReconciliationCheckFailure,
  type ReconciliationContext,
} from '../reconcile-ledger.command.js';
import { keysetPages } from './keyset-pages.js';

/** Page size of the ref list. */
export const R5_REF_PAGE_SIZE = 500;

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
 * 3. `advanceTrustedState(db, trusted, next, readAt)`, a compare-and-set that also stores `readAt`
 *    (when this run read the state, before the proof): lost → the run `failed`, no finding, no
 *    retry, no entry verified (the run that won verifies them).
 * 4. Every ref posted from `min(from, cutoff)` until `readAt`, with `cutoff` the stored state's
 *    `readAt` (the last run listed the refs posted before it; `from` for a state stored before
 *    migration 0008, which has none), whose tx id is above the old trusted tx id (up to `next`'s),
 *    or at most the old one and posted since `cutoff` (recorded after the last run read its state,
 *    so that run never saw it, however long its proof took), or null (a `replayed` receipt):
 *    `LedgerPort.verifyEntry(entryId, payloadHash, next)`; a failure → `verification_failed` under
 *    the ref's tenant (source key `ledger_entries:<id>`). Entry failures do not undo step 3.
 *    After a re-anchor (any of `readTrustedState`'s, one per restore, audit fixes OPS-1), a ref
 *    posted before it whose tx id is above the re-anchored state's, or posted since its lost-from
 *    time, may name the lost history: its tx id says nothing about the restored one, so it is
 *    verified like a ref without a tx id, on every run that lists it, also after a later re-anchor
 *    (R4 re-enqueues it and the posting path posts it once; the ref keeps its old tx id, and its
 *    entry then verifies by entry id and payload hash).
 * `ledger_verified_tx_id` follows the stored state. Runs only inside `SystemContext`.
 */
@Injectable()
export class R5VerificationCheck implements ReconciliationCheck {
  readonly name = 'R5';
  private readonly logger = new Logger(R5VerificationCheck.name);

  constructor(
    private readonly ledger: LedgerPort,
    private readonly system: LedgerSystemRepository,
    private readonly metrics: LedgerMetricsPort,
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
    if (trusted !== null) this.metrics.verifiedTxId(trusted.txId);
    this.metrics.unverifiedTxLag(current.txId, trusted?.txId ?? 0n);

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

    if (!(await this.system.advanceTrustedState(db, trusted, next, readAt))) {
      throw new ReconciliationCheckFailure(
        `the trusted ledger state of ${db} changed during the run (compare-and-set lost)`,
      );
    }
    this.metrics.verifiedTxId(next.txId);
    this.metrics.unverifiedTxLag(current.txId, next.txId);

    // Refs of txs the stored state includes but recorded after the last run read it: posted since
    // `cutoff`, the read time that run stored (it listed only the refs posted before it). A ref
    // recorded later still falls in a later run's window, with its own cutoff. A state stored
    // before 0008 has no read time: every ref of the window is verified once.
    const cutoff = stored === null ? null : (stored.readAt ?? ctx.from);
    const since = cutoff === null || ctx.from.getTime() <= cutoff.getTime() ? ctx.from : cutoff;
    const oldTxId = trusted?.txId ?? 0n;
    const found: LedgerDiscrepancyInput[] = [];
    for await (const page of keysetPages(
      R5_REF_PAGE_SIZE,
      (last: LedgerEntryRef) => ({ tenantId: last.tenantId, id: last.entryId }),
      (after) => this.system.listEntryRefs(since, readAt, after, R5_REF_PAGE_SIZE),
    )) {
      for (const ref of page) {
        if (!needsVerification(ref, oldTxId, next.txId, cutoff, stored?.reanchors ?? [])) {
          continue;
        }
        const failure = await this.verify(ref, next);
        if (failure !== null) found.push(this.finding(ctx, failure));
      }
    }
    return found;
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
 * - a `replayed` receipt without a tx id, which is verified on every run that lists it;
 * - a ref of a lost history (`fromLostHistory`, any re-anchor), whatever its tx id, on every run
 *   that lists it.
 */
function needsVerification(
  ref: LedgerEntryRef,
  oldTxId: bigint,
  nextTxId: bigint,
  cutoff: Date | null,
  reanchors: readonly LedgerReanchorMark[],
): boolean {
  if (ref.immudbTxId === null) return true;
  const txId = ref.immudbTxId;
  if (reanchors.some((reanchor) => fromLostHistory(ref, txId, reanchor))) return true;
  if (ref.immudbTxId > nextTxId) return false;
  if (ref.immudbTxId > oldTxId) return true;
  return cutoff !== null && ref.postedAt.getTime() >= cutoff.getTime();
}

/**
 * A ref recorded before `reanchor` whose tx id is above the re-anchored state's, or that was posted
 * since its lost-from time: its tx id may belong to the history that restore lost. A later
 * re-anchor does not clear it: a ref lost in an earlier restore and not posted again keeps
 * matching its own re-anchor.
 */
function fromLostHistory(ref: LedgerEntryRef, txId: bigint, reanchor: LedgerReanchorMark): boolean {
  if (ref.postedAt.getTime() >= reanchor.at.getTime()) return false;
  return txId > reanchor.txId || ref.postedAt.getTime() >= reanchor.lostFrom.getTime();
}

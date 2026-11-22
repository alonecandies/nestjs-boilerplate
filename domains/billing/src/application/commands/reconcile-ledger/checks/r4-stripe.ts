import { LEDGER_POSTING_REQUESTED_EVENT } from '@domain/billing-contracts';
import { Injectable } from '@nestjs/common';
import { PLATFORM_TENANT_ID } from '@platform/common';
import type Stripe from 'stripe';
import { v5 as uuidv5 } from 'uuid';
import { resolveLedgerAccount } from '../../../../domain/ledger/ledger.accounts.js';
import { ledgerEntryId } from '../../../../domain/ledger/ledger.ids.js';
import {
  LEDGER_NAMESPACE,
  type LedgerEntry,
  type LedgerEntryKind,
} from '../../../../domain/ledger/ledger.types.js';
import type { LedgerDiscrepancyInput } from '../../../../domain/ledger/ledger-discrepancy.js';
import { BillingOutbox } from '../../../../infrastructure/persistence/billing-outbox.js';
import { StripeService } from '../../../../infrastructure/stripe/stripe.service.js';
import {
  type LedgerPostingOwner,
  ledgerPostingRequest,
  postingOwnerOf,
} from '../../../ledger/ledger-posting-request.js';
import {
  draftFromBalanceTransaction,
  isPlatformLedgerKind,
  ledgerFeeAccountOf,
  ledgerKindOf,
} from '../../../ledger/posting-rules.js';
import {
  type ResolvedStripeOwner,
  StripeOwnerResolver,
} from '../../../ledger/stripe-owner-resolver.js';
import { LedgerPort } from '../../../ports/ledger.port.js';
import { LedgerSystemRepository } from '../../../repositories/ledger.system-repository.js';
import type { LedgerEntryRef } from '../../../repositories/ledger-receipts.repository.js';
import type { ReconciliationCheck, ReconciliationContext } from '../reconcile-ledger.command.js';
import { keysetPages } from './keyset-pages.js';

/** Page size of the ref list. */
export const R4_REF_PAGE_SIZE = 500;
/** `stripeEventType` of a posting R4 re-enqueues (its `stripeEventId` is `reconcile:<runId>`). */
export const R4_RECONCILE_EVENT_TYPE = 'reconcile.missing_entry';

/** Envelope (= outbox row) id of an R4 re-enqueue: new per run, stable within one. */
export function r4EnvelopeId(runId: string, txnId: string): string {
  return uuidv5(`reconcile:${runId}:${txnId}`, LEDGER_NAMESPACE);
}

type Finding = Omit<LedgerDiscrepancyInput, 'detectedBy' | 'runId'>;

/** The owner of platform money: no resolver call, never `tenant_unresolved`. */
const PLATFORM_POSTING_OWNER: ResolvedStripeOwner = Object.freeze({
  tenantId: PLATFORM_TENANT_ID,
  userId: null,
  paymentId: null,
  unresolved: false,
});

/** Σdebit − Σcredit of `entry`'s postings on `account` in `currency`. */
function movement(entry: LedgerEntry, account: string, currency: string): bigint {
  let total = 0n;
  for (const posting of entry.postings) {
    if (posting.currency !== currency) continue;
    if (resolveLedgerAccount(posting.accountId, entry.tenantId, posting.currency) !== account) {
      continue;
    }
    total += posting.debit - posting.credit;
  }
  return total;
}

/**
 * R4, Stripe's balance transactions against the ledger (ledger design §4; outbox plan Task 16):
 * the self-healing path for a lost webhook, a `fee_unavailable` posting and a ledger enabled late.
 * Reads every page (`R4_REF_PAGE_SIZE`) of `listEntryRefs(from, now)` over all tenants into a map
 * by entry id, so the lookup does not depend on the owner Stripe's metadata names today and sees
 * entries posted during the grace period; then every balance transaction Stripe lists with
 * `created` in `[from, to)` (a transaction that moves nothing posts nothing and is skipped). Per
 * transaction, entry id `ledgerEntryId('stripe:txn:' + id)`:
 * - no ref, or no ref whose entry `LedgerPort.getEntry(ref.tenantId, entryId)` returns →
 *   `missing_entry` (source key `stripe:txn:<id>`) and one `billing.ledger-posting.v1` record
 *   through `enqueueMissingPostings` ("Envelope ids": id `r4EnvelopeId(runId, id)`, event
 *   `reconcile:<runId>` / `reconcile.missing_entry`, object `balance_transaction`), both under the
 *   owner `StripeOwnerResolver` gives for the expanded source (its signed payment id named only when
 *   `findPaymentsByIds` shows it is the owner's, `postingOwnerOf`, as on the webhook path); platform
 *   kinds go to the platform
 *   tenant without asking it. An unresolved owner of a tenant-level kind → both under the platform
 *   tenant, plus a `tenant_unresolved` finding. Each record is enqueued as soon as it is found, so a
 *   Stripe failure later in the listing fails the check and keeps what was enqueued;
 * - an entry whose net movement on `asset:stripe_balance` ≠ `net`, whose movement on its fee
 *   account ≠ the posting rules' for the transaction (`fee`; for a `stripe_fee` transaction its
 *   amount lands on that account too), or whose postings are in another currency →
 *   `stripe_amount_mismatch` under the ref's tenant, with expected and found values.
 * The envelope id is new per run, so the next run re-enqueues a still-missing entry while its
 * finding (no run id in it) adds no row. Runs only inside `SystemContext` (the refs are read
 * first, through a system method).
 */
@Injectable()
export class R4StripeCheck implements ReconciliationCheck {
  readonly name = 'R4';

  constructor(
    private readonly ledger: LedgerPort,
    private readonly system: LedgerSystemRepository,
    private readonly stripe: StripeService,
    private readonly owners: StripeOwnerResolver,
    private readonly outbox: BillingOutbox,
  ) {}

  async run(ctx: ReconciliationContext): Promise<readonly LedgerDiscrepancyInput[]> {
    const refs = await this.refsByEntry(ctx.from, new Date());
    const found: Finding[] = [];
    for await (const txn of this.stripe.listBalanceTransactions({ from: ctx.from, to: ctx.to })) {
      if (txn.amount === 0 && txn.fee === 0) continue;
      const sourceKey = `stripe:txn:${txn.id}`;
      const entryId = ledgerEntryId(sourceKey);
      const posted = await this.entryOf(refs.get(entryId) ?? [], entryId);
      if (posted === null) {
        found.push(...(await this.reenqueue(ctx, txn, sourceKey, entryId)));
        continue;
      }
      const mismatch = amountMismatch(txn, posted.ref, posted.entry, sourceKey);
      if (mismatch !== null) found.push(mismatch);
    }
    return found.map((row) => ({ ...row, detectedBy: this.name, runId: ctx.runId }));
  }

  /** Every ref posted in `[from, to)`, all tenants, by entry id. */
  private async refsByEntry(from: Date, to: Date): Promise<Map<string, LedgerEntryRef[]>> {
    const byEntry = new Map<string, LedgerEntryRef[]>();
    for await (const page of keysetPages(
      R4_REF_PAGE_SIZE,
      (last: LedgerEntryRef) => ({ tenantId: last.tenantId, id: last.entryId }),
      (after) => this.system.listEntryRefs(from, to, after, R4_REF_PAGE_SIZE),
    )) {
      for (const ref of page) {
        const refs = byEntry.get(ref.entryId);
        if (refs === undefined) byEntry.set(ref.entryId, [ref]);
        else refs.push(ref);
      }
    }
    return byEntry;
  }

  /** The first ref whose entry the ledger returns under the ref's tenant. */
  private async entryOf(
    refs: readonly LedgerEntryRef[],
    entryId: string,
  ): Promise<{ readonly ref: LedgerEntryRef; readonly entry: LedgerEntry } | null> {
    for (const ref of refs) {
      const entry = await this.ledger.getEntry(ref.tenantId, entryId);
      if (entry !== null) return { ref, entry };
    }
    return null;
  }

  /** Enqueues the posting of a missing transaction and returns its findings. */
  private async reenqueue(
    ctx: ReconciliationContext,
    txn: Stripe.BalanceTransaction,
    sourceKey: string,
    entryId: string,
  ): Promise<Finding[]> {
    const kind: LedgerEntryKind = ledgerKindOf(txn.reporting_category);
    const owner = isPlatformLedgerKind(kind)
      ? PLATFORM_POSTING_OWNER
      : await this.owners.resolve(txn.source);
    const { payload, options } = ledgerPostingRequest(
      {
        id: `reconcile:${ctx.runId}`,
        type: R4_RECONCILE_EVENT_TYPE,
        livemode: this.stripe.livemode,
        created: txn.created,
      },
      await this.postingOwner(owner),
      'balance_transaction',
      txn.id,
    );
    const record = this.outbox.record(LEDGER_POSTING_REQUESTED_EVENT, payload, {
      ...options,
      eventId: r4EnvelopeId(ctx.runId, txn.id),
    });
    await this.system.enqueueMissingPostings([record]);

    const findings: Finding[] = [
      {
        tenantId: owner.tenantId,
        kind: 'missing_entry',
        sourceKey,
        expected: {
          entryId,
          kind,
          net: String(txn.net),
          fee: String(txn.fee),
          currency: txn.currency.toLowerCase(),
        },
        actual: { entryId: null },
      },
    ];
    if (owner.unresolved) {
      const source = txn.source;
      findings.push({
        tenantId: PLATFORM_TENANT_ID,
        kind: 'tenant_unresolved',
        sourceKey,
        expected: { owner: 'tenant' },
        actual: {
          tenantId: PLATFORM_TENANT_ID,
          source: typeof source === 'string' ? source : (source?.id ?? null),
        },
      });
    }
    return findings;
  }

  /**
   * The posting owner, with the payment id the metadata signed checked like the webhook's
   * (`postingOwnerOf`): the payment is read by `(tenant, id)` through the system method, and named
   * only when it is the owner's.
   */
  private async postingOwner(owner: ResolvedStripeOwner): Promise<LedgerPostingOwner> {
    if (owner.paymentId === null) return postingOwnerOf(owner, null);
    const [payment] = await this.system.findPaymentsByIds([
      { tenantId: owner.tenantId, id: owner.paymentId },
    ]);
    return postingOwnerOf(owner, payment ?? null);
  }
}

/** The entry of a transaction against Stripe's amounts (see `R4StripeCheck`). */
function amountMismatch(
  txn: Stripe.BalanceTransaction,
  ref: LedgerEntryRef,
  entry: LedgerEntry,
  sourceKey: string,
): Finding | null {
  const currency = txn.currency.toLowerCase();
  const kind = ledgerKindOf(txn.reporting_category);
  const feeAccount = ledgerFeeAccountOf(kind);
  // The posting rules' movement on the fee account: `fee`, plus the amount of a `stripe_fee`.
  const draft = draftFromBalanceTransaction(txn, {
    tenantId: entry.tenantId,
    paymentId: null,
    presentment: null,
  });
  const expectedFee = (draft?.lines ?? [])
    .filter((line) => line.account === feeAccount)
    .reduce((sum, line) => sum + line.debit - line.credit, 0n);
  const currencies = [...new Set(entry.postings.map((posting) => posting.currency))].sort();
  const actualNet = movement(entry, 'asset:stripe_balance', currency);
  const actualFee = movement(entry, feeAccount, currency);
  const sameCurrency = currencies.length === 1 && currencies[0] === currency;
  if (sameCurrency && actualNet === BigInt(txn.net) && actualFee === expectedFee) return null;
  return {
    tenantId: ref.tenantId,
    kind: 'stripe_amount_mismatch',
    sourceKey,
    expected: { entryId: entry.id, net: String(txn.net), fee: String(expectedFee), currency },
    actual: { net: String(actualNet), fee: String(actualFee), currency: currencies.join(',') },
  };
}

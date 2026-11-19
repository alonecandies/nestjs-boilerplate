import { defineSystemMethod } from '@platform/database';
import { OUTBOX_SYSTEM_METHODS } from '@platform/outbox';

/**
 * Billing's pinned system methods (spec §9 numbering): the only ways billing reaches the
 * `app_system` pool, by `<repository>.<method>`. All are `system` scope (crons, platform
 * webhooks and the outbox relay, inside `SystemContext`).
 * - `stripeEvents`: 5 (the purge cron) and the stripe_events half of 8 (platform webhooks).
 * - `outbox` (spec §9 item 6 plus the purge; outbox plan Task 6): the relay's poll, mark and
 *   purge of `billing.outbox`, and `insertAsPlatform`, the only door for `PLATFORM_TENANT_ID`
 *   rows (G-1) — the shared `@platform/outbox` methods.
 * - The ledger (spec §9 items 9-11, outbox plan Task 11; `DrizzleLedgerSystemRepository`):
 *   `ledgerReconciliation` (9: the cross-tenant lists of R3; 10: the findings and R4's
 *   re-enqueued postings), `ledgerEntryRefs.recordAsSystem` (10: refs of platform or user-less
 *   postings), `ledgerAccounts.recordPlatformAccounts` (plan delta 4, ruling 2: the
 *   `PLATFORM_TENANT_ID` account rows a tenant's posting opens), `ledgerTrustedState` and
 *   `ledgerRuns` (11: R5's compare-and-set and the run bookkeeping).
 */
export const BILLING_SYSTEM_METHODS = Object.freeze({
  stripeEvents: Object.freeze({
    /** 5: the hourly purge cron. */
    deleteProcessedBefore: defineSystemMethod('stripeEvents.deleteProcessedBefore', 'system'),
    /** 8 (stripe_events half): webhooks without a user (`payout.*`, unattributed fees). */
    markProcessedAsPlatform: defineSystemMethod('stripeEvents.markProcessedAsPlatform', 'system'),
  }),
  outbox: Object.freeze({
    pollUnpublished: OUTBOX_SYSTEM_METHODS.poll,
    markPublished: OUTBOX_SYSTEM_METHODS.markPublished,
    insertAsPlatform: OUTBOX_SYSTEM_METHODS.insertAsPlatform,
    deletePublishedBefore: OUTBOX_SYSTEM_METHODS.deletePublishedBefore,
  }),
  ledgerReconciliation: Object.freeze({
    /** 9: R3's paid payments of every tenant in a window, a keyset page by (tenant_id, id). */
    listSucceededPayments: defineSystemMethod(
      'ledgerReconciliation.listSucceededPayments',
      'system',
    ),
    /** 9: the entry refs of every tenant in a window, a keyset page by (tenant_id, entry_id). */
    listEntryRefs: defineSystemMethod('ledgerReconciliation.listEntryRefs', 'system'),
    /** 10: the findings of a run, under their tenants (deterministic ids, append-only). */
    appendDiscrepancies: defineSystemMethod('ledgerReconciliation.appendDiscrepancies', 'system'),
    /** 10: R4's re-enqueued postings, outbox rows of any tenant. */
    enqueueMissingPostings: defineSystemMethod(
      'ledgerReconciliation.enqueueMissingPostings',
      'system',
    ),
  }),
  ledgerEntryRefs: Object.freeze({
    /** 10: the refs of platform or user-less postings (the consumer in SystemContext). */
    recordAsSystem: defineSystemMethod('ledgerEntryRefs.recordAsSystem', 'system'),
  }),
  ledgerAccounts: Object.freeze({
    /** Plan delta 4: PLATFORM_TENANT_ID account rows only. */
    recordPlatformAccounts: defineSystemMethod('ledgerAccounts.recordPlatformAccounts', 'system'),
  }),
  ledgerTrustedState: Object.freeze({
    /** 11: the stored trusted state of an immudb database. */
    read: defineSystemMethod('ledgerTrustedState.read', 'system'),
    /** 11: R5's compare-and-set advance after the dual proof. */
    advance: defineSystemMethod('ledgerTrustedState.advance', 'system'),
  }),
  ledgerRuns: Object.freeze({
    /** 11: a reconciliation run starts. */
    start: defineSystemMethod('ledgerRuns.start', 'system'),
    /** 11: a reconciliation run finishes (once). */
    finish: defineSystemMethod('ledgerRuns.finish', 'system'),
  }),
});

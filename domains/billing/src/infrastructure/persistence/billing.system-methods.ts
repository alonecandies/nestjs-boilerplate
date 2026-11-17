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
 * L-10 (the ledger's reconciliation and `ledgerEntryRefs.recordAsSystem`) extends this list.
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
});

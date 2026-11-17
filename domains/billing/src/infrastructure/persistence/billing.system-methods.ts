import { defineSystemMethod } from '@platform/database';

/**
 * Billing's pinned system methods (spec §9 numbering): the only ways billing reaches the
 * `app_system` pool, by `<repository>.<method>`. Both are `system` scope (crons and platform
 * webhooks, inside `SystemContext`). G-1 (`outbox.insertAsPlatform`) and L-10 (the ledger's
 * reconciliation and `ledgerEntryRefs.recordAsSystem`) extend this list, with their grants.
 */
export const BILLING_SYSTEM_METHODS = Object.freeze({
  stripeEvents: Object.freeze({
    /** 5: the hourly purge cron. */
    deleteProcessedBefore: defineSystemMethod('stripeEvents.deleteProcessedBefore', 'system'),
    /** 8 (stripe_events half): webhooks without a user (`payout.*`, unattributed fees). */
    markProcessedAsPlatform: defineSystemMethod('stripeEvents.markProcessedAsPlatform', 'system'),
  }),
});

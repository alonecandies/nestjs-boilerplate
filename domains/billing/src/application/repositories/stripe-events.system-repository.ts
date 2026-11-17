import type { StripeEventReceipt } from './stripe-events.repository.js';

/**
 * The principal-less side of the Stripe events ledger (spec §9, methods 5 and the `stripe_events`
 * half of 8; implemented on the `app_system` pool by `DrizzleStripeEventsSystemRepository`). Both
 * methods are `system` scope: they run only inside `SystemContext.run(…)` and never join a runtime
 * transaction; each call commits on its own.
 */
export abstract class StripeEventsSystemRepository {
  /**
   * Deletes the events processed before `cutoff`, in every tenant (the platform tenant included),
   * oldest first in 15-minute time slices (at most 96 per call, each one multi-shard DELETE without
   * `FOR UPDATE`, backed by the `processed_at` index on each shard, far below the role's
   * `statement_timeout`), and returns how many rows went. A larger backlog is left for the next
   * call.
   */
  abstract deleteProcessedBefore(cutoff: Date): Promise<number>;

  /**
   * Records an event that has no user (`INSERT … ON CONFLICT DO NOTHING`): a platform-level event
   * under `PLATFORM_TENANT_ID`, or a user-less one under its tenant. `true` on the first delivery,
   * `false` for a duplicate.
   * @throws Error when `event.userId` is not null (a user's event runs as that user, at runtime)
   */
  abstract markProcessedAsPlatform(event: StripeEventReceipt): Promise<boolean>;
}

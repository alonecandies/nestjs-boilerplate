import { Injectable } from '@nestjs/common';
import { InjectSystemDatabase, purgeInTimeSlices, SystemDatabase } from '@platform/database';
import { and, lt, lte, min } from 'drizzle-orm';
import type { StripeEventReceipt } from '../../application/repositories/stripe-events.repository.js';
import type { StripeEventsSystemRepository } from '../../application/repositories/stripe-events.system-repository.js';
import { type BillingSchema, stripeEvents } from './billing.schema.js';
import { BILLING_SYSTEM_METHODS } from './billing.system-methods.js';

const { stripeEvents: methods } = BILLING_SYSTEM_METHODS;

/**
 * `stripe_events` on the `app_system` (BYPASSRLS) pool, through `SystemDatabase.run` and the pinned
 * methods only: each call is logged and counted, refused outside `SystemContext`, and commits on
 * its own (never inside a runtime transaction). `app_system` holds SELECT, INSERT and DELETE on
 * `stripe_events` (0000_init) and only SELECT on `payments` (for reconciliation).
 */
@Injectable()
export class DrizzleStripeEventsSystemRepository implements StripeEventsSystemRepository {
  constructor(@InjectSystemDatabase() private readonly system: SystemDatabase<BillingSchema>) {}

  deleteProcessedBefore(cutoff: Date): Promise<number> {
    // Time slices oldest first (`purgeInTimeSlices`): min(processed_at) of the due rows, then one
    // multi-shard DELETE up to min + 15 minutes (never reaching the cutoff: `<` it), at most 96 per
    // run, each committing on its own. No FOR UPDATE and no `id IN (SELECT … LIMIT n)` batch (SH-6:
    // Citus cannot push it down on a distributed table); each slice stays far below the role's
    // statement_timeout, so a backlog drains over a few runs (B3 ruling 6, final review F3).
    return this.system.run(methods.deleteProcessedBefore, async (db) => {
      const { deleted } = await purgeInTimeSlices({
        cutoff,
        oldestDue: async () => {
          const [row] = await db
            .select({ oldest: min(stripeEvents.processedAt) })
            .from(stripeEvents)
            .where(lt(stripeEvents.processedAt, cutoff));
          return row?.oldest ?? null;
        },
        deleteThrough: async (bound) =>
          (
            await db
              .delete(stripeEvents)
              .where(
                and(lte(stripeEvents.processedAt, bound), lt(stripeEvents.processedAt, cutoff)),
              )
          ).count,
      });
      return deleted;
    });
  }

  async markProcessedAsPlatform(event: StripeEventReceipt): Promise<boolean> {
    if (event.userId !== null) {
      // Before any SQL: an event with a user is that user's, recorded at runtime under RLS.
      throw new Error(
        `Stripe event ${event.id} has a user: record it as that user (StripeEventsRepository.markProcessed)`,
      );
    }
    return this.system.run(methods.markProcessedAsPlatform, async (db) => {
      const inserted = await db
        .insert(stripeEvents)
        .values({ tenantId: event.tenantId, id: event.id, userId: null, type: event.type })
        .onConflictDoNothing({ target: [stripeEvents.tenantId, stripeEvents.id] })
        .returning({ id: stripeEvents.id });
      return inserted.length > 0;
    });
  }
}

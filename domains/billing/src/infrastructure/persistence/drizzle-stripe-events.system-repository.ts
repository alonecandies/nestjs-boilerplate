import { Injectable } from '@nestjs/common';
import { InjectSystemDatabase, SystemDatabase } from '@platform/database';
import { lt } from 'drizzle-orm';
import type { StripeEventReceipt } from '../../application/repositories/stripe-events.repository.js';
import type { StripeEventsSystemRepository } from '../../application/repositories/stripe-events.system-repository.js';
import { type BillingSchema, stripeEvents } from './billing.schema.js';
import { BILLING_SYSTEM_METHODS } from './billing.system-methods.js';

const { stripeEvents: methods } = BILLING_SYSTEM_METHODS;

/**
 * `stripe_events` on the `app_system` (BYPASSRLS) pool, through `SystemDatabase.run` and the pinned
 * methods only: each call is logged and counted, refused outside `SystemContext`, and commits on
 * its own (never inside a runtime transaction). `app_system` holds SELECT, INSERT and DELETE on
 * `stripe_events` and nothing on `payments` (0003_rls).
 */
@Injectable()
export class DrizzleStripeEventsSystemRepository implements StripeEventsSystemRepository {
  constructor(@InjectSystemDatabase() private readonly system: SystemDatabase<BillingSchema>) {}

  deleteProcessedBefore(cutoff: Date): Promise<number> {
    // One multi-shard DELETE, no FOR UPDATE (SH-6): Citus cannot push an `id IN (SELECT … LIMIT n)`
    // batch down on a distributed table. Bounded by the role's statement_timeout (B3 ruling 6).
    return this.system.run(methods.deleteProcessedBefore, async (db) => {
      const result = await db.delete(stripeEvents).where(lt(stripeEvents.processedAt, cutoff));
      return result.count;
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

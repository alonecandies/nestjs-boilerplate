import { Injectable } from '@nestjs/common';
import { type DrizzleTransactionalAdapter, TransactionHost } from '@platform/database';
import { inArray, lt } from 'drizzle-orm';
import type {
  StripeEventReceipt,
  StripeEventsRepository,
} from '../../application/repositories/stripe-events.repository.js';
import { stripeEvents } from './billing.schema.js';

@Injectable()
export class DrizzleStripeEventsRepository implements StripeEventsRepository {
  constructor(private readonly txHost: TransactionHost<DrizzleTransactionalAdapter>) {}

  async markProcessed(event: StripeEventReceipt): Promise<boolean> {
    const inserted = await this.txHost.tx
      .insert(stripeEvents)
      .values({ tenantId: event.tenantId, id: event.id, userId: event.userId, type: event.type })
      .onConflictDoNothing({ target: [stripeEvents.tenantId, stripeEvents.id] })
      .returning({ id: stripeEvents.id });
    return inserted.length > 0;
  }

  async deleteProcessedBefore(cutoff: Date, limit: number): Promise<number> {
    // System method 5 (spec §9): B3-11 moves it to a *.system-repository.ts; SH-6 rewrites the LIMIT
    // subquery, which Citus cannot push down on a distributed table.
    const tx = this.txHost.tx;
    // DELETE has no LIMIT in Postgres: bound it through the id subquery (index range scan).
    const result = await tx
      .delete(stripeEvents)
      .where(
        inArray(
          stripeEvents.id,
          tx
            .select({ id: stripeEvents.id })
            .from(stripeEvents)
            .where(lt(stripeEvents.processedAt, cutoff))
            .limit(limit),
        ),
      );
    return result.count;
  }
}

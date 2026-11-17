import { Injectable } from '@nestjs/common';
import { type DrizzleTransactionalAdapter, TransactionHost } from '@platform/database';
import { lt } from 'drizzle-orm';
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

  async deleteProcessedBefore(cutoff: Date): Promise<number> {
    // System method 5 (spec §9): B3-11 moves it to a *.system-repository.ts. One multi-shard
    // DELETE, no FOR UPDATE (SH-6): Citus cannot push an `id IN (SELECT … LIMIT n)` batch down
    // on a distributed table. Bounded by the role's statement_timeout (B3 ruling 6).
    const result = await this.txHost.tx
      .delete(stripeEvents)
      .where(lt(stripeEvents.processedAt, cutoff));
    return result.count;
  }
}

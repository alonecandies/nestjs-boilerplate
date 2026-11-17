import { Injectable } from '@nestjs/common';
import {
  type DrizzleTransactionalAdapter,
  inUnitOfWork,
  TransactionHost,
} from '@platform/database';
import type {
  StripeEventReceipt,
  StripeEventsRepository,
} from '../../application/repositories/stripe-events.repository.js';
import type { BillingSchema } from './billing.schema.js';
import { stripeEvents } from './billing.schema.js';

/**
 * `stripe_events` as the event's user, on the runtime pool under RLS: the call runs in the open
 * unit of work (`inUnitOfWork`), or in its own one with the principal's context.
 */
@Injectable()
export class DrizzleStripeEventsRepository implements StripeEventsRepository {
  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactionalAdapter<BillingSchema>>,
  ) {}

  markProcessed(event: StripeEventReceipt): Promise<boolean> {
    return inUnitOfWork(this.txHost, async (tx) => {
      const inserted = await tx
        .insert(stripeEvents)
        .values({ tenantId: event.tenantId, id: event.id, userId: event.userId, type: event.type })
        .onConflictDoNothing({ target: [stripeEvents.tenantId, stripeEvents.id] })
        .returning({ id: stripeEvents.id });
      return inserted.length > 0;
    });
  }
}

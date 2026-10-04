import { type DrizzleTransactionalAdapter, TransactionHost } from '@app/database';
import { Injectable } from '@nestjs/common';
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
      .values({ id: event.id, type: event.type })
      .onConflictDoNothing({ target: stripeEvents.id })
      .returning({ id: stripeEvents.id });
    return inserted.length > 0;
  }
}

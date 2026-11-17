import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { StripeEventsSystemRepository } from '../../repositories/stripe-events.system-repository.js';
import { PurgeStripeEventsCommand } from './purge-stripe-events.command.js';

/**
 * Deletes old webhook receipts with one multi-shard DELETE per run (sharding design SH-6: a batched
 * `LIMIT` subquery cannot be pushed down once `stripe_events` is distributed). The role's
 * `statement_timeout` bounds it; the hourly schedule keeps each run's backlog to about an hour of
 * events. Only rows far past Stripe's redelivery window go, so deduplication is unaffected.
 * Principal-less and cross-tenant: system method `stripeEvents.deleteProcessedBefore`.
 */
@CommandHandler(PurgeStripeEventsCommand)
export class PurgeStripeEventsHandler implements ICommandHandler<PurgeStripeEventsCommand> {
  constructor(private readonly stripeEvents: StripeEventsSystemRepository) {}

  execute(command: PurgeStripeEventsCommand): Promise<number> {
    return this.stripeEvents.deleteProcessedBefore(command.cutoff);
  }
}

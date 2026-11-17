import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { StripeEventsSystemRepository } from '../../repositories/stripe-events.system-repository.js';
import { PurgeStripeEventsCommand } from './purge-stripe-events.command.js';

/**
 * Deletes old webhook receipts in bounded progress (sharding design SH-6: a batched `LIMIT`
 * subquery cannot be pushed down once `stripe_events` is distributed): 15-minute time slices oldest
 * first, at most 96 multi-shard DELETEs per run, each far below the role's `statement_timeout`; a
 * larger backlog drains over the next hourly runs (B3 final review F3). Only rows far past Stripe's redelivery window go, so deduplication is unaffected.
 * Principal-less and cross-tenant: system method `stripeEvents.deleteProcessedBefore`, which runs
 * only inside the `SystemContext` that `PurgeStripeEventsCron` opens (elsewhere it is refused with
 * SYSTEM_CONTEXT_REQUIRED).
 */
@CommandHandler(PurgeStripeEventsCommand)
export class PurgeStripeEventsHandler implements ICommandHandler<PurgeStripeEventsCommand> {
  constructor(private readonly stripeEvents: StripeEventsSystemRepository) {}

  execute(command: PurgeStripeEventsCommand): Promise<number> {
    return this.stripeEvents.deleteProcessedBefore(command.cutoff);
  }
}

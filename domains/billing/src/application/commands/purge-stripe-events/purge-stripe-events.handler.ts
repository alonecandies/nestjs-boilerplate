import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { PURGE_STRIPE_EVENTS_BATCH_SIZE } from '../../../billing.constants.js';
import { StripeEventsRepository } from '../../repositories/stripe-events.repository.js';
import { PurgeStripeEventsCommand } from './purge-stripe-events.command.js';

/** Safety valve: at most this many batches per run (the next hourly run continues). */
const MAX_BATCHES_PER_RUN = 200;

/**
 * Deletes old webhook receipts in bounded batches (short statements: no long row locks, no WAL
 * spike). Only rows far past Stripe's redelivery window go, so deduplication is unaffected.
 */
@CommandHandler(PurgeStripeEventsCommand)
export class PurgeStripeEventsHandler implements ICommandHandler<PurgeStripeEventsCommand> {
  constructor(private readonly stripeEvents: StripeEventsRepository) {}

  async execute(command: PurgeStripeEventsCommand): Promise<number> {
    let total = 0;
    for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch += 1) {
      const deleted = await this.stripeEvents.deleteProcessedBefore(
        command.cutoff,
        PURGE_STRIPE_EVENTS_BATCH_SIZE,
      );
      total += deleted;
      if (deleted < PURGE_STRIPE_EVENTS_BATCH_SIZE) break;
    }
    return total;
  }
}

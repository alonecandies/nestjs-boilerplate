import { Command } from '@nestjs/cqrs';

/** Deletes `stripe_events` processed before `cutoff`; resolves with the number of rows deleted. */
export class PurgeStripeEventsCommand extends Command<number> {
  constructor(readonly cutoff: Date) {
    super();
  }
}

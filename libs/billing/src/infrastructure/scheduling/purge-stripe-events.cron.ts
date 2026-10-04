import { WithLock } from '@app/redis';
import { Injectable, Logger } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PurgeStripeEventsCommand } from '../../application/commands/purge-stripe-events/purge-stripe-events.command.js';
import {
  PURGE_STRIPE_EVENTS_LOCK,
  PURGE_STRIPE_EVENTS_LOCK_TTL_MS,
  STRIPE_EVENTS_RETENTION_DAYS,
} from '../../billing.constants.js';

const DAY_MS = 86_400_000;

/**
 * Hourly purge of `stripe_events` older than `STRIPE_EVENTS_RETENTION_DAYS` (the dedupe ledger
 * would otherwise grow with every webhook forever). `@Cron` fires on every replica; `@WithLock`
 * (Redis redlock, auto-extended while running) lets exactly one of them do the work. Registered
 * only where `ScheduleModule.forRoot()` is imported (billing-service, monolith).
 */
@Injectable()
export class PurgeStripeEventsCron {
  private readonly logger = new Logger(PurgeStripeEventsCron.name);

  constructor(private readonly commandBus: CommandBus) {}

  @Cron(CronExpression.EVERY_HOUR, {
    name: 'billing.purge-stripe-events',
    timeZone: 'UTC',
    waitForCompletion: true,
  })
  @WithLock(PURGE_STRIPE_EVENTS_LOCK, PURGE_STRIPE_EVENTS_LOCK_TTL_MS)
  async run(): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - STRIPE_EVENTS_RETENTION_DAYS * DAY_MS);
      const deleted = await this.commandBus.execute(new PurgeStripeEventsCommand(cutoff));
      this.logger.log({ deleted, cutoff }, 'Old Stripe events purged');
    } catch (error) {
      // A failed run is retried by the next tick; never let it escape into the scheduler.
      this.logger.error({ err: error }, 'Purging old Stripe events failed');
    }
  }
}

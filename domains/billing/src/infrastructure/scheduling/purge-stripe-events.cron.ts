import { Injectable, Logger } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SystemContext } from '@platform/common';
import { WithLock } from '@platform/redis';
import { PurgeStripeEventsCommand } from '../../application/commands/purge-stripe-events/purge-stripe-events.command.js';
import {
  PURGE_STRIPE_EVENTS_LOCK,
  PURGE_STRIPE_EVENTS_LOCK_TTL_MS,
  STRIPE_EVENTS_RETENTION_DAYS,
} from '../../billing.constants.js';

const DAY_MS = 86_400_000;

/** The cron's name, and the system context its purge runs in. */
const PURGE_STRIPE_EVENTS_JOB = 'billing.purge-stripe-events';

/**
 * Hourly purge of `stripe_events` older than `STRIPE_EVENTS_RETENTION_DAYS` (the dedupe ledger
 * would otherwise grow with every webhook forever). `@Cron` fires on every replica; `@WithLock`
 * (Redis redlock, auto-extended while running) lets exactly one of them do the work. Registered
 * only where `ScheduleModule.forRoot()` is imported (billing-service, monolith).
 *
 * The purge is principal-less and crosses tenants, so the command runs inside
 * `SystemContext.run('billing.purge-stripe-events')` (system method
 * `stripeEvents.deleteProcessedBefore`). The context is opened here, at the scheduled entry point,
 * never in the handler: a command dispatched from a request must not gain system status.
 */
@Injectable()
export class PurgeStripeEventsCron {
  private readonly logger = new Logger(PurgeStripeEventsCron.name);

  constructor(private readonly commandBus: CommandBus) {}

  @Cron(CronExpression.EVERY_HOUR, {
    name: PURGE_STRIPE_EVENTS_JOB,
    timeZone: 'UTC',
    waitForCompletion: true,
  })
  @WithLock(PURGE_STRIPE_EVENTS_LOCK, PURGE_STRIPE_EVENTS_LOCK_TTL_MS)
  async run(): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - STRIPE_EVENTS_RETENTION_DAYS * DAY_MS);
      const deleted = await SystemContext.run(PURGE_STRIPE_EVENTS_JOB, () =>
        this.commandBus.execute(new PurgeStripeEventsCommand(cutoff)),
      );
      this.logger.log({ deleted, cutoff }, 'Old Stripe events purged');
    } catch (error) {
      // A failed run is retried by the next tick; never let it escape into the scheduler.
      this.logger.error({ err: error }, 'Purging old Stripe events failed');
    }
  }
}

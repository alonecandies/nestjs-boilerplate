import { WithLock } from '@app/redis';
import { Injectable, Logger } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import { Cron } from '@nestjs/schedule';
import type { DailyDigestResult } from '../../application/commands/send-daily-digest/send-daily-digest.command.js';
import { SendDailyDigestCommand } from '../../application/commands/send-daily-digest/send-daily-digest.command.js';
import {
  DAILY_DIGEST_CRON,
  DAILY_DIGEST_JOB_NAME,
  DAILY_DIGEST_LOCK,
  DAILY_DIGEST_LOCK_TTL_MS,
  DIGEST_MAX_RECIPIENTS,
} from '../../notifications.constants.js';

/**
 * 09:00 UTC every day. `@Cron` fires on EVERY replica; `@WithLock` lets only the one that wins
 * the Redis lock run it (the others resolve `undefined` immediately). `waitForCompletion` stops a
 * slow run from overlapping the next tick on the same replica.
 */
@Injectable()
export class DailyDigestCron {
  private readonly logger = new Logger(DailyDigestCron.name);

  constructor(private readonly commandBus: CommandBus) {}

  @Cron(DAILY_DIGEST_CRON, {
    name: DAILY_DIGEST_JOB_NAME,
    timeZone: 'UTC',
    waitForCompletion: true,
  })
  @WithLock(DAILY_DIGEST_LOCK, DAILY_DIGEST_LOCK_TTL_MS)
  async run(): Promise<DailyDigestResult | undefined> {
    try {
      const result = await this.commandBus.execute(
        new SendDailyDigestCommand({ maxRecipients: DIGEST_MAX_RECIPIENTS }),
      );
      this.logger.log(
        `Daily digest: ${result.enqueued} queued, ${result.failed} failed, ${result.scanned} recipients scanned`,
      );
      return result;
    } catch (error) {
      // A cron callback that throws is only logged by the scheduler; keep the context here.
      this.logger.error(
        'Daily digest run failed',
        error instanceof Error ? error.stack : String(error),
      );
      return undefined;
    }
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SystemContext } from '@platform/common';
import { WithLock } from '@platform/redis';
import { PurgeExpiredSessionsCommand } from '../../application/commands/purge-expired-sessions/purge-expired-sessions.command.js';
import { PURGE_SESSIONS_LOCK, PURGE_SESSIONS_LOCK_TTL_MS } from '../../identity.constants.js';

/**
 * Hourly purge of expired sessions. `@Cron` fires on every replica; `@WithLock` (Redis redlock,
 * auto-extended while running) lets exactly one of them do the work, the others skip.
 * Registered only where `ScheduleModule.forRoot()` is imported (identity-service, monolith).
 * No principal: the purge is a `system` method (spec §9 method 5), so the run is a
 * `SystemContext` (`identity.purge-expired-sessions`), the only way to reach it.
 */
/** The system-context reason of the purge (`<domain>.<job>`, logged and counted per call). */
export const PURGE_SESSIONS_SYSTEM_REASON = 'identity.purge-expired-sessions';

@Injectable()
export class PurgeExpiredSessionsCron {
  private readonly logger = new Logger(PurgeExpiredSessionsCron.name);

  constructor(private readonly commandBus: CommandBus) {}

  @Cron(CronExpression.EVERY_HOUR, {
    name: 'identity.purge-expired-sessions',
    timeZone: 'UTC',
    waitForCompletion: true,
  })
  @WithLock(PURGE_SESSIONS_LOCK, PURGE_SESSIONS_LOCK_TTL_MS)
  async run(): Promise<void> {
    try {
      const deleted = await SystemContext.run(PURGE_SESSIONS_SYSTEM_REASON, () =>
        this.commandBus.execute(new PurgeExpiredSessionsCommand(new Date())),
      );
      this.logger.log({ deleted }, 'Expired sessions purged');
    } catch (error) {
      // A failed run is retried by the next tick; never let it escape into the scheduler.
      this.logger.error({ err: error }, 'Purging expired sessions failed');
    }
  }
}

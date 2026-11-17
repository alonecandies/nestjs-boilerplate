import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { SessionsSystemRepository } from '../../persistence/sessions.system-repository.js';
import { PurgeExpiredSessionsCommand } from './purge-expired-sessions.command.js';

/**
 * Deletes expired sessions in bounded progress (sessions are distributed by `user_id`; a `LIMIT`ed
 * batch cannot be pushed down to the shards): time slices oldest first (`purgeInTimeSlices`, B3
 * final review F3). It reads the oldest due timestamp, deletes up to it + 15 minutes and repeats,
 * at most 96 multi-shard statements per run, each committing on its own and far below the role's
 * `statement_timeout`. A backlog larger than one run (a day of expiries) drains over the next
 * hourly ticks; a failed run is retried by the next tick, and the slices it committed stay deleted.
 * Revoked-but-unexpired sessions are KEPT on purpose: they are what makes replaying a rotated
 * refresh token detectable until the token itself expires.
 * A `system` method (spec §9 method 5): it runs only inside `SystemContext.run`.
 */
@CommandHandler(PurgeExpiredSessionsCommand)
export class PurgeExpiredSessionsHandler implements ICommandHandler<PurgeExpiredSessionsCommand> {
  constructor(private readonly sessions: SessionsSystemRepository) {}

  execute(command: PurgeExpiredSessionsCommand): Promise<number> {
    return this.sessions.deleteExpired(command.now);
  }
}

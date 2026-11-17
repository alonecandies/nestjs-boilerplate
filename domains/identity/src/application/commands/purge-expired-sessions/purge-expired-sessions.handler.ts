import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { SessionsRepository } from '../../persistence/sessions.repository.js';
import { PurgeExpiredSessionsCommand } from './purge-expired-sessions.command.js';

/**
 * Deletes expired sessions with ONE multi-shard DELETE per run (sessions are distributed by
 * `user_id`; a `LIMIT`ed batch cannot be pushed down to the shards). The statement takes no row
 * locks beyond the rows it deletes and is bounded by the role's `statement_timeout`; a run that
 * times out is retried by the next hourly tick. Revoked-but-unexpired sessions are KEPT on purpose:
 * they are what makes replaying a rotated refresh token detectable until the token itself expires.
 */
@CommandHandler(PurgeExpiredSessionsCommand)
export class PurgeExpiredSessionsHandler implements ICommandHandler<PurgeExpiredSessionsCommand> {
  constructor(private readonly sessions: SessionsRepository) {}

  execute(command: PurgeExpiredSessionsCommand): Promise<number> {
    return this.sessions.deleteExpired(command.now);
  }
}

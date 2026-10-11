import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { PURGE_SESSIONS_BATCH_SIZE } from '../../../identity.constants.js';
import { SessionsRepository } from '../../persistence/sessions.repository.js';
import { PurgeExpiredSessionsCommand } from './purge-expired-sessions.command.js';

/** Safety valve: at most this many batches per run (the next hourly run continues). */
const MAX_BATCHES_PER_RUN = 200;

/**
 * Deletes expired sessions in bounded batches (short statements: no long row locks, no WAL
 * spike). Revoked-but-unexpired sessions are KEPT on purpose: they are what makes replaying a
 * rotated refresh token detectable until the token itself expires.
 */
@CommandHandler(PurgeExpiredSessionsCommand)
export class PurgeExpiredSessionsHandler implements ICommandHandler<PurgeExpiredSessionsCommand> {
  constructor(private readonly sessions: SessionsRepository) {}

  async execute(command: PurgeExpiredSessionsCommand): Promise<number> {
    let total = 0;
    for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch += 1) {
      const deleted = await this.sessions.deleteExpired(command.now, PURGE_SESSIONS_BATCH_SIZE);
      total += deleted;
      if (deleted < PURGE_SESSIONS_BATCH_SIZE) break;
    }
    return total;
  }
}

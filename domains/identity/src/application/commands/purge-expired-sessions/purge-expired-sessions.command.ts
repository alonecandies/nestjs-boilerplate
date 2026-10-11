import { Command } from '@nestjs/cqrs';

/** Deletes sessions that expired before `now`; resolves with the number of rows deleted. */
export class PurgeExpiredSessionsCommand extends Command<number> {
  constructor(readonly now: Date) {
    super();
  }
}

import { describe, expect, it } from 'vitest';
import { mockOf } from '../../../../test/mocks.js';
import { PURGE_SESSIONS_BATCH_SIZE } from '../../../identity.constants.js';
import type { SessionsRepository } from '../../persistence/sessions.repository.js';
import { PurgeExpiredSessionsCommand } from './purge-expired-sessions.command.js';
import { PurgeExpiredSessionsHandler } from './purge-expired-sessions.handler.js';

describe('PurgeExpiredSessionsHandler', () => {
  const now = new Date('2026-09-29T12:00:00.000Z');

  it('deletes in bounded batches until a partial batch, and returns the total', async () => {
    const sessions = mockOf<SessionsRepository>();
    sessions.deleteExpired
      .mockResolvedValueOnce(PURGE_SESSIONS_BATCH_SIZE)
      .mockResolvedValueOnce(PURGE_SESSIONS_BATCH_SIZE)
      .mockResolvedValueOnce(7);

    const total = await new PurgeExpiredSessionsHandler(sessions).execute(
      new PurgeExpiredSessionsCommand(now),
    );

    expect(total).toBe(2 * PURGE_SESSIONS_BATCH_SIZE + 7);
    expect(sessions.deleteExpired).toHaveBeenCalledTimes(3);
    expect(sessions.deleteExpired).toHaveBeenCalledWith(now, PURGE_SESSIONS_BATCH_SIZE);
  });

  it('stops after the per-run batch cap even if rows keep coming', async () => {
    const sessions = mockOf<SessionsRepository>({
      deleteExpired: async () => PURGE_SESSIONS_BATCH_SIZE,
    });
    await new PurgeExpiredSessionsHandler(sessions).execute(new PurgeExpiredSessionsCommand(now));
    expect(sessions.deleteExpired).toHaveBeenCalledTimes(200);
  });
});

import { describe, expect, it } from 'vitest';
import { mockOf } from '../../../../test/mocks.js';
import type { SessionsRepository } from '../../persistence/sessions.repository.js';
import { PurgeExpiredSessionsCommand } from './purge-expired-sessions.command.js';
import { PurgeExpiredSessionsHandler } from './purge-expired-sessions.handler.js';

describe('PurgeExpiredSessionsHandler', () => {
  const now = new Date('2026-09-29T12:00:00.000Z');

  it('deletes every expired session in ONE call per run and returns the count', async () => {
    const sessions = mockOf<SessionsRepository>();
    sessions.deleteExpired.mockResolvedValueOnce(12_345);

    const total = await new PurgeExpiredSessionsHandler(sessions).execute(
      new PurgeExpiredSessionsCommand(now),
    );

    expect(total).toBe(12_345);
    expect(sessions.deleteExpired).toHaveBeenCalledOnce();
    expect(sessions.deleteExpired).toHaveBeenCalledWith(now);
  });

  it('lets a failed DELETE reject (the cron logs it; the next hourly run retries)', async () => {
    const sessions = mockOf<SessionsRepository>();
    sessions.deleteExpired.mockRejectedValueOnce(new Error('statement timeout'));
    await expect(
      new PurgeExpiredSessionsHandler(sessions).execute(new PurgeExpiredSessionsCommand(now)),
    ).rejects.toThrow('statement timeout');
    expect(sessions.deleteExpired).toHaveBeenCalledOnce();
  });
});

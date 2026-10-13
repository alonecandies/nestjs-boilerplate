import { Logger } from '@nestjs/common';
import type { CommandBus } from '@nestjs/cqrs';
import { CronExpression } from '@nestjs/schedule';
import { redisConfig } from '@platform/config';
import { DistributedLockService, type LockBackend, RedisKeyService } from '@platform/redis';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockOf } from '../../../test/mocks.js';
import { PurgeExpiredSessionsCommand } from '../../application/commands/purge-expired-sessions/purge-expired-sessions.command.js';
import { PurgeExpiredSessionsCron } from './purge-expired-sessions.cron.js';

type Routine = (signal: AbortSignal) => Promise<void>;

describe('PurgeExpiredSessionsCron', () => {
  const using = vi.fn(async (_keys: string[], _ttl: number, _settings: unknown, routine: Routine) =>
    routine(new AbortController().signal),
  );
  let commandBus: ReturnType<typeof mockOf<CommandBus>>;
  let cron: PurgeExpiredSessionsCron;

  beforeEach(() => {
    // The real lock service over a fake redlock: @WithLock resolves it through its holder.
    const lock = new DistributedLockService(
      { using } as unknown as LockBackend,
      new RedisKeyService(redisConfig.parse({ REDIS_KEY_PREFIX: 'test' })),
    );
    lock.onModuleInit();
    commandBus = mockOf<CommandBus>({ execute: async () => 3 });
    cron = new PurgeExpiredSessionsCron(commandBus);
  });

  it('is an hourly cron (metadata survives @WithLock) guarded by the identity:purge-sessions lock', async () => {
    expect(Reflect.getMetadata('SCHEDULE_CRON_OPTIONS', cron.run)).toMatchObject({
      cronTime: CronExpression.EVERY_HOUR,
      name: 'identity.purge-expired-sessions',
    });

    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    await cron.run();

    expect(log).toHaveBeenCalledExactlyOnceWith({ deleted: 3 }, 'Expired sessions purged');
    expect(using).toHaveBeenCalledWith(
      ['test:lock:identity:purge-sessions'],
      60_000,
      expect.any(Object),
      expect.any(Function),
    );
    expect(commandBus.execute).toHaveBeenCalledWith(expect.any(PurgeExpiredSessionsCommand));
  });

  it('skips the run when another replica holds the lock', async () => {
    using.mockRejectedValueOnce(new Error('lock unavailable'));
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await expect(cron.run()).resolves.toBeUndefined();
    expect(commandBus.execute).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('"identity:purge-sessions" could not be acquired (lock unavailable)'),
    );
  });

  it('never lets a failed purge escape into the scheduler', async () => {
    const failure = new Error('db down');
    commandBus.execute.mockRejectedValue(failure);
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await expect(cron.run()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledExactlyOnceWith(
      { err: failure },
      'Purging expired sessions failed',
    );
  });
});

import { redisConfig } from '@app/config';
import { DistributedLockService, type LockBackend, RedisKeyService } from '@app/redis';
import type { CommandBus } from '@nestjs/cqrs';
import { CronExpression } from '@nestjs/schedule';
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

    await cron.run();

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
    await expect(cron.run()).resolves.toBeUndefined();
    expect(commandBus.execute).not.toHaveBeenCalled();
  });

  it('never lets a failed purge escape into the scheduler', async () => {
    commandBus.execute.mockRejectedValue(new Error('db down'));
    await expect(cron.run()).resolves.toBeUndefined();
  });
});

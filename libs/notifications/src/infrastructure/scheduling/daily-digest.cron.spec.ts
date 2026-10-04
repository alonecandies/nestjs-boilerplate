import { redisConfig } from '@app/config';
import { DistributedLockService, type LockBackend, RedisKeyService } from '@app/redis';
import { createMock } from '@app/testing';
import type { CommandBus } from '@nestjs/cqrs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asClass } from '../../../test/support/fixtures.js';
import { SendDailyDigestCommand } from '../../application/commands/send-daily-digest/send-daily-digest.command.js';
import {
  DAILY_DIGEST_JOB_NAME,
  DAILY_DIGEST_LOCK,
  DAILY_DIGEST_LOCK_TTL_MS,
  DIGEST_MAX_RECIPIENTS,
} from '../../notifications.constants.js';
import { DailyDigestCron } from './daily-digest.cron.js';

/** `@nestjs/schedule`'s metadata key (not exported from the package root). */
const SCHEDULE_CRON_OPTIONS = 'SCHEDULE_CRON_OPTIONS';

/** Registers a DistributedLockService whose (fake) redlock grants or refuses the lock. */
function installLock(acquire: boolean) {
  const using = vi.fn(
    async (
      _keys: string[],
      _ttl: number,
      _settings: unknown,
      routine: (signal: AbortSignal) => Promise<void>,
    ) => {
      if (!acquire) throw Object.assign(new Error('locked'), { name: 'ResourceLockedError' });
      await routine(new AbortController().signal);
    },
  );
  const service = new DistributedLockService(
    { using } as unknown as LockBackend,
    new RedisKeyService(redisConfig.parse({ REDIS_KEY_PREFIX: 'test' })),
  );
  service.onModuleInit();
  return using;
}

describe('DailyDigestCron', () => {
  afterEach(() => {
    // Leave a lock runner that always runs, so other specs are unaffected.
    installLock(true);
  });

  it('is scheduled at 09:00 UTC, once at a time (metadata survives the @WithLock wrapper)', () => {
    expect(Reflect.getMetadata(SCHEDULE_CRON_OPTIONS, DailyDigestCron.prototype.run)).toEqual({
      cronTime: '0 9 * * *',
      name: DAILY_DIGEST_JOB_NAME,
      timeZone: 'UTC',
      waitForCompletion: true,
    });
  });

  it('runs the bounded digest under the distributed lock and returns the result', async () => {
    const using = installLock(true);
    const result = { scanned: 3, enqueued: 2, failed: 0 };
    const commandBus = createMock<CommandBus>({ execute: async () => result });

    await expect(new DailyDigestCron(asClass(commandBus)).run()).resolves.toEqual(result);

    expect(using).toHaveBeenCalledWith(
      [`test:lock:${DAILY_DIGEST_LOCK}`],
      DAILY_DIGEST_LOCK_TTL_MS,
      expect.anything(),
      expect.any(Function),
    );
    const [command] = commandBus.execute.mock.calls[0] ?? [];
    expect(command).toBeInstanceOf(SendDailyDigestCommand);
    expect((command as SendDailyDigestCommand).options).toEqual({
      maxRecipients: DIGEST_MAX_RECIPIENTS,
    });
  });

  it('skips on replicas that lose the lock', async () => {
    installLock(false);
    const commandBus = createMock<CommandBus>();
    await expect(new DailyDigestCron(asClass(commandBus)).run()).resolves.toBeUndefined();
    expect(commandBus.execute).not.toHaveBeenCalled();
  });

  it('logs and swallows a failed run (the scheduler would only log it without context)', async () => {
    installLock(true);
    const commandBus = createMock<CommandBus>();
    commandBus.execute.mockRejectedValueOnce(new Error('cassandra down'));
    await expect(new DailyDigestCron(asClass(commandBus)).run()).resolves.toBeUndefined();
  });
});

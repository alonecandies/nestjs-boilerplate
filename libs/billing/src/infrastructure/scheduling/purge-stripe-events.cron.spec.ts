import { redisConfig } from '@app/config';
import { DistributedLockService, type LockBackend, RedisKeyService } from '@app/redis';
import { createMock } from '@app/testing';
import { Logger } from '@nestjs/common';
import type { CommandBus } from '@nestjs/cqrs';
import { CronExpression } from '@nestjs/schedule';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PurgeStripeEventsCommand } from '../../application/commands/purge-stripe-events/purge-stripe-events.command.js';
import { PurgeStripeEventsCron } from './purge-stripe-events.cron.js';

type Routine = (signal: AbortSignal) => Promise<void>;

describe('PurgeStripeEventsCron', () => {
  const using = vi.fn(async (_keys: string[], _ttl: number, _settings: unknown, routine: Routine) =>
    routine(new AbortController().signal),
  );
  let commandBus: ReturnType<typeof createMock<CommandBus>>;
  let cron: PurgeStripeEventsCron;

  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  beforeEach(() => {
    // The real lock service over a fake redlock: @WithLock resolves it through its holder.
    const lock = new DistributedLockService(
      { using } as unknown as LockBackend,
      new RedisKeyService(redisConfig.parse({ REDIS_KEY_PREFIX: 'test' })),
    );
    lock.onModuleInit();
    commandBus = createMock<CommandBus>();
    commandBus.execute.mockResolvedValue(3);
    cron = new PurgeStripeEventsCron(commandBus as unknown as CommandBus);
    vi.useFakeTimers({ now: new Date('2026-10-05T12:00:00.000Z'), toFake: ['Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
    using.mockClear();
  });

  it('is an hourly cron (metadata survives @WithLock) guarded by the billing:purge-stripe-events lock', async () => {
    expect(Reflect.getMetadata('SCHEDULE_CRON_OPTIONS', cron.run)).toMatchObject({
      cronTime: CronExpression.EVERY_HOUR,
      name: 'billing.purge-stripe-events',
    });

    await cron.run();

    expect(using).toHaveBeenCalledWith(
      ['test:lock:billing:purge-stripe-events'],
      60_000,
      expect.any(Object),
      expect.any(Function),
    );
    const [command] = commandBus.execute.mock.calls[0] ?? [];
    expect(command).toBeInstanceOf(PurgeStripeEventsCommand);
    // 30-day retention, far past Stripe's 3-day redelivery window.
    expect((command as PurgeStripeEventsCommand).cutoff).toEqual(
      new Date('2026-09-05T12:00:00.000Z'),
    );
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

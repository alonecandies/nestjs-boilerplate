import { Logger } from '@nestjs/common';
import type { CommandBus } from '@nestjs/cqrs';
import { CronExpression } from '@nestjs/schedule';
import { getPrincipal, SystemContext } from '@platform/common';
import { redisConfig } from '@platform/config';
import { DistributedLockService, type LockBackend, RedisKeyService } from '@platform/redis';
import { createMock } from '@platform/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReconcileLedgerCommand } from '../../application/commands/reconcile-ledger/reconcile-ledger.command.js';
import { RECONCILE_LEDGER_LOCK_TTL_MS } from '../../billing.constants.js';
import type { LedgerConfig } from '../ledger/ledger.config.js';
import { ReconcileLedgerCron } from './reconcile-ledger.cron.js';

type Routine = (signal: AbortSignal) => Promise<void>;

const enabled: LedgerConfig = { enabled: true, reconcileLookbackHours: 72, verify: false };
const disabled: LedgerConfig = { ...enabled, enabled: false };

describe('ReconcileLedgerCron', () => {
  const using = vi.fn(async (_keys: string[], _ttl: number, _settings: unknown, routine: Routine) =>
    routine(new AbortController().signal),
  );
  let commandBus: ReturnType<typeof createMock<CommandBus>>;

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
    commandBus.execute.mockResolvedValue({ found: {}, appended: {} });
  });

  afterEach(() => {
    using.mockClear();
  });

  const cronWith = (config: LedgerConfig) =>
    new ReconcileLedgerCron(commandBus as unknown as CommandBus, config);

  it('is an hourly UTC cron named billing.reconcile-ledger that waits for completion', () => {
    const cron = cronWith(enabled);
    expect(Reflect.getMetadata('SCHEDULE_CRON_OPTIONS', cron.run)).toMatchObject({
      cronTime: CronExpression.EVERY_HOUR,
      name: 'billing.reconcile-ledger',
      timeZone: 'UTC',
      waitForCompletion: true,
    });
  });

  it('does nothing while the ledger is disabled: no lock, no command', async () => {
    await cronWith(disabled).run();

    expect(using).not.toHaveBeenCalled();
    expect(commandBus.execute).not.toHaveBeenCalled();
  });

  it("enabled: one ReconcileLedgerCommand (default window) under the lock, inside SystemContext('billing.reconcile-ledger')", async () => {
    let seen: unknown;
    commandBus.execute.mockImplementation(async (command: unknown) => {
      seen = {
        command,
        system: SystemContext.current(),
        principal: getPrincipal(),
      };
      return { found: {}, appended: {} };
    });

    await cronWith(enabled).run();

    expect(using).toHaveBeenCalledWith(
      ['test:lock:billing:reconcile-ledger'],
      RECONCILE_LEDGER_LOCK_TTL_MS,
      expect.any(Object),
      expect.any(Function),
    );
    expect(commandBus.execute).toHaveBeenCalledTimes(1);
    expect(seen).toEqual({
      command: new ReconcileLedgerCommand(),
      system: { reason: 'billing.reconcile-ledger' },
      principal: undefined,
    });
    expect((seen as { command: ReconcileLedgerCommand }).command.window).toBeUndefined();
    expect(SystemContext.isActive()).toBe(false);
  });

  it('skips the run when another replica holds the lock', async () => {
    using.mockRejectedValueOnce(new Error('lock unavailable'));

    await expect(cronWith(enabled).run()).resolves.toBeUndefined();
    expect(commandBus.execute).not.toHaveBeenCalled();
  });

  it('logs a rejecting command and never lets it escape into the scheduler', async () => {
    const error = vi.spyOn(Logger.prototype, 'error');
    commandBus.execute.mockRejectedValue(new Error('postgres down'));

    await expect(cronWith(enabled).run()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Ledger reconciliation failed',
    );
  });
});

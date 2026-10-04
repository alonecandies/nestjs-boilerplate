import { redisConfig } from '@app/config';
import {
  ExecutionError,
  type ExecutionStats,
  type RedlockAbortSignal,
  ResourceLockedError,
} from '@sesamecare-oss/redlock';
import { describe, expect, it, vi } from 'vitest';
import { RedisKeyService } from '../keys/redis-key.service.js';
import {
  assertLockArgs,
  DistributedLockService,
  isLockContention,
  type LockBackend,
  lockExtensionThreshold,
} from './distributed-lock.service.js';
import { getLockRunner } from './lock-registry.js';

type Routine = (signal: RedlockAbortSignal) => Promise<unknown>;

const keys = new RedisKeyService(redisConfig.parse({ REDIS_KEY_PREFIX: 'svc' }));

/** ExecutionError as redlock raises it when every vote was against (retryCount: 0). */
function executionError(...reasons: Error[]): ExecutionError {
  const stats: ExecutionStats = {
    membershipSize: 1,
    quorumSize: 1,
    votesFor: new Set(),
    votesAgainst: new Map(reasons.map((reason, index) => [index as never, reason])),
  };
  return new ExecutionError('The operation was unable to achieve a quorum.', [
    Promise.resolve(stats),
  ]);
}

/** Fake redlock: `mode` decides whether acquisition succeeds, and whether release fails. */
function fakeRedlock(mode: { acquire?: Error; release?: Error } = {}) {
  const using = vi.fn(
    async (_resources: string[], _ttl: number, _settings: object, routine: Routine) => {
      if (mode.acquire) throw mode.acquire;
      const controller = new AbortController();
      let outcome: { ok: true; value: unknown } | { ok: false; error: unknown };
      try {
        outcome = { ok: true, value: await routine(controller.signal) };
      } catch (error) {
        outcome = { ok: false, error };
      }
      // redlock releases in `finally`, so a release error replaces the routine's outcome.
      if (mode.release) throw mode.release;
      if (!outcome.ok) throw outcome.error;
      return outcome.value;
    },
  );
  return { backend: { using } as unknown as LockBackend, using };
}

describe('DistributedLockService.using', () => {
  it('runs the routine under <prefix>:lock:<resource> with an auto-extension threshold', async () => {
    const { backend, using } = fakeRedlock();
    const service = new DistributedLockService(backend, keys);
    const fn = vi.fn(async (signal: AbortSignal) => (signal.aborted ? 'aborted' : 'done'));

    await expect(service.using('cron:digest', 60_000, fn)).resolves.toEqual({
      acquired: true,
      result: 'done',
    });
    expect(using).toHaveBeenCalledWith(
      ['svc:lock:cron:digest'],
      60_000,
      { automaticExtensionThreshold: 5_000 },
      expect.any(Function),
    );
    expect(fn).toHaveBeenCalledOnce();
  });

  it('distinguishes `undefined` results from skipped runs', async () => {
    const service = new DistributedLockService(fakeRedlock().backend, keys);
    await expect(service.using('r', 1_000, async () => undefined)).resolves.toEqual({
      acquired: true,
      result: undefined,
    });
  });

  it('skips (reason "held") when another replica holds the lock', async () => {
    const { backend } = fakeRedlock({ acquire: executionError(new ResourceLockedError('locked')) });
    const service = new DistributedLockService(backend, keys);
    const fn = vi.fn(async () => 'never');
    await expect(service.using('r', 1_000, fn)).resolves.toEqual({
      acquired: false,
      reason: 'held',
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it('skips (reason "error") when Redis is unavailable', async () => {
    const { backend } = fakeRedlock({
      acquire: executionError(new Error('Connection is closed.')),
    });
    const service = new DistributedLockService(backend, keys);
    await expect(service.using('r', 1_000, async () => 'x')).resolves.toEqual({
      acquired: false,
      reason: 'error',
    });
  });

  it('propagates routine errors, even when the release fails too', async () => {
    const boom = new Error('job failed');
    const service = new DistributedLockService(
      fakeRedlock({ release: new Error('release failed') }).backend,
      keys,
    );
    await expect(
      service.using('r', 1_000, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });

  it('keeps the result when only the release fails (the key expires on its own)', async () => {
    const service = new DistributedLockService(
      fakeRedlock({ release: new Error('release failed') }).backend,
      keys,
    );
    await expect(service.using('r', 1_000, async () => 42)).resolves.toEqual({
      acquired: true,
      result: 42,
    });
  });

  it('validates arguments before touching Redis', async () => {
    const { backend, using } = fakeRedlock();
    const service = new DistributedLockService(backend, keys);
    await expect(service.using('', 1_000, async () => 1)).rejects.toThrow(TypeError);
    await expect(service.using('r', 50, async () => 1)).rejects.toThrow(RangeError);
    await expect(service.using('r', 1_000.5, async () => 1)).rejects.toThrow(RangeError);
    expect(using).not.toHaveBeenCalled();
  });

  it('registers itself for @WithLock on module init', () => {
    const service = new DistributedLockService(fakeRedlock().backend, keys);
    service.onModuleInit();
    expect(getLockRunner()).toBe(service);
  });
});

describe('lock helpers', () => {
  it('extension threshold = ttl/4 clamped to [50ms, 5s] and always < ttl - 100ms', () => {
    expect(lockExtensionThreshold(200)).toBe(50);
    expect(lockExtensionThreshold(4_000)).toBe(1_000);
    expect(lockExtensionThreshold(3_600_000)).toBe(5_000);
    for (const ttl of [200, 201, 1_000, 19_999, 20_000, 60_000]) {
      expect(lockExtensionThreshold(ttl)).toBeLessThanOrEqual(ttl - 100);
    }
  });

  it('assertLockArgs rejects bad resources and TTLs', () => {
    expect(() => assertLockArgs('ok', 200)).not.toThrow();
    expect(() => assertLockArgs('', 1_000)).toThrow(TypeError);
    expect(() => assertLockArgs('ok', 199)).toThrow(RangeError);
  });

  it('isLockContention only accepts "already locked" votes', async () => {
    await expect(isLockContention(new ResourceLockedError('x'))).resolves.toBe(true);
    await expect(isLockContention(executionError(new ResourceLockedError('x')))).resolves.toBe(
      true,
    );
    await expect(
      isLockContention(executionError(new ResourceLockedError('x'), new Error('down'))),
    ).resolves.toBe(false);
    await expect(isLockContention(executionError())).resolves.toBe(false);
    await expect(isLockContention(new Error('other'))).resolves.toBe(false);
  });
});

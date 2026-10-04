import { SetMetadata } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LockResult } from './lock.types.js';
import { type LockRunner, registerLockRunner } from './lock-registry.js';
import { WithLock } from './with-lock.decorator.js';

const CRON_META = 'test:cron';

/** Runner stub: `acquire` decides whether the routine runs. */
function runner(acquire: boolean) {
  const lockRunner: LockRunner = {
    async using<T>(
      _resource: string,
      _ttl: number,
      fn: (signal: AbortSignal) => Promise<T>,
    ): Promise<LockResult<T>> {
      return acquire
        ? { acquired: true, result: await fn(new AbortController().signal) }
        : { acquired: false, reason: 'held' };
    },
  };
  const using = vi.spyOn(lockRunner, 'using');
  return { lockRunner, using };
}

class Jobs {
  runs = 0;

  @SetMetadata(CRON_META, 'above')
  @WithLock('jobs:purge', 60_000)
  async purge(batch: number): Promise<string> {
    this.runs++;
    return `purged ${batch}`;
  }

  @WithLock('jobs:digest', 10_000)
  @SetMetadata(CRON_META, 'below')
  async digest(): Promise<void> {
    this.runs++;
  }
}

describe('@WithLock', () => {
  afterEach(() => registerLockRunner(undefined));

  it('runs the method (with `this` and args) when the lock is acquired', async () => {
    const { lockRunner, using } = runner(true);
    registerLockRunner(lockRunner);
    const jobs = new Jobs();

    await expect(jobs.purge(3)).resolves.toBe('purged 3');
    expect(jobs.runs).toBe(1);
    expect(using).toHaveBeenCalledWith('jobs:purge', 60_000, expect.any(Function));
  });

  it('skips the method and resolves undefined when another replica holds the lock', async () => {
    registerLockRunner(runner(false).lockRunner);
    const jobs = new Jobs();
    await expect(jobs.purge(1)).resolves.toBeUndefined();
    expect(jobs.runs).toBe(0);
  });

  it('keeps metadata of decorators applied before AND after it (e.g. @Cron)', () => {
    const { purge, digest } = Jobs.prototype;
    expect(Reflect.getMetadata(CRON_META, purge)).toBe('above');
    expect(Reflect.getMetadata(CRON_META, digest)).toBe('below');
    expect(purge.name).toBe('purge');
  });

  it('fails loudly when RedisModule was never initialised', async () => {
    await expect(new Jobs().digest()).rejects.toThrow(/DistributedLockService is not initialised/);
  });

  it('validates arguments at decoration time and rejects non-methods', () => {
    expect(() => WithLock('', 1_000)).toThrow(TypeError);
    expect(() => WithLock('x', 10)).toThrow(RangeError);
    const decorate = WithLock('x', 1_000);
    const descriptor: PropertyDescriptor = { value: 42 };
    expect(() => decorate({}, 'notAMethod', descriptor)).toThrow(/can only decorate methods/);
  });
});

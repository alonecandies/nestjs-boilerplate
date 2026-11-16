import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImmudbError } from '../errors/immudb.error.js';
import { ImmudbSessionPool, type PoolableSession } from './session-pool.js';

interface FakeSession extends PoolableSession {
  readonly n: number;
  keepAlive: ReturnType<typeof vi.fn<() => Promise<void>>>;
  close: ReturnType<typeof vi.fn<() => Promise<void>>>;
}

function factory(): { open: () => Promise<FakeSession>; made: FakeSession[] } {
  const made: FakeSession[] = [];
  const open = async (): Promise<FakeSession> => {
    const session: FakeSession = {
      n: made.length + 1,
      keepAlive: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    made.push(session);
    return session;
  };
  return { open, made };
}

describe('ImmudbSessionPool', () => {
  afterEach(() => vi.useRealTimers());

  it('reuses an idle session', async () => {
    const { open, made } = factory();
    const pool = new ImmudbSessionPool(open, 2, 60_000);
    await pool.use(async (s) => s.n);
    expect(await pool.use(async (s) => s.n)).toBe(1);
    expect(made).toHaveLength(1);
    await pool.close();
  });

  it('caps open sessions at size and queues the rest', async () => {
    const { open, made } = factory();
    const pool = new ImmudbSessionPool(open, 1, 60_000);
    let release!: () => void;
    const first = pool.use(
      () =>
        new Promise<number>((r) => {
          release = () => r(1);
        }),
    );
    const second = pool.use(async (s) => s.n);
    // A macrotask lets the first use() open its session and start its work.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(made).toHaveLength(1);
    release();
    expect(await Promise.all([first, second])).toEqual([1, 1]);
    await pool.close();
  });

  it('settles callers queued behind a session that failed to open, instead of leaving them hanging', async () => {
    let attempts = 0;
    let failFirst!: (error: Error) => void;
    const open = (): Promise<FakeSession> => {
      attempts++;
      if (attempts === 1) {
        return new Promise<FakeSession>((_, reject) => {
          failFirst = reject;
        });
      }
      return Promise.reject(new ImmudbError('unavailable', 'immudb is down'));
    };
    const pool = new ImmudbSessionPool(open, 1, 60_000);
    const first = pool.use(async () => 1);
    const second = pool.use(async () => 2);
    const third = pool.use(async () => 3);
    await new Promise<void>((resolve) => setImmediate(resolve));
    failFirst(new ImmudbError('unavailable', 'immudb is down'));

    const settled = await Promise.race([
      Promise.allSettled([first, second, third]),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 500)),
    ]);
    expect(settled).not.toBe('hung');
    expect((settled as PromiseSettledResult<number>[]).map((r) => r.status)).toEqual([
      'rejected',
      'rejected',
      'rejected',
    ]);
    await pool.close();
  });

  it('discards a session that failed with unavailable and opens a fresh one', async () => {
    const { open, made } = factory();
    const pool = new ImmudbSessionPool(open, 1, 60_000);
    await expect(
      pool.use(async () => {
        throw new ImmudbError('unavailable', 'no session found');
      }),
    ).rejects.toThrow('no session found');
    expect(made[0]?.close).toHaveBeenCalledTimes(1);
    expect(await pool.use(async (s) => s.n)).toBe(2);
    await pool.close();
  });

  it('keeps a session after a domain error such as duplicate-key', async () => {
    const { open, made } = factory();
    const pool = new ImmudbSessionPool(open, 1, 60_000);
    await expect(
      pool.use(async () => {
        throw new ImmudbError('duplicate-key', 'key already exists');
      }),
    ).rejects.toThrow();
    expect(await pool.use(async (s) => s.n)).toBe(1);
    expect(made).toHaveLength(1);
    await pool.close();
  });

  it('keeps idle sessions alive and drops one whose keepalive fails', async () => {
    vi.useFakeTimers();
    const { open, made } = factory();
    const pool = new ImmudbSessionPool(open, 1, 1_000);
    await pool.use(async () => undefined);
    made[0]?.keepAlive.mockRejectedValueOnce(new Error('no session found'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(made[0]?.close).toHaveBeenCalledTimes(1);
    expect(await pool.use(async (s) => s.n)).toBe(2);
    await pool.close();
  });

  it('closes idle sessions and refuses new work after close', async () => {
    const { open, made } = factory();
    const pool = new ImmudbSessionPool(open, 1, 60_000);
    await pool.use(async () => undefined);
    await pool.close();
    expect(made[0]?.close).toHaveBeenCalledTimes(1);
    await expect(pool.use(async () => undefined)).rejects.toMatchObject({ kind: 'unavailable' });
  });
});

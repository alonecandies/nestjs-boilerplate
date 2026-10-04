import { EventEmitter } from 'node:events';
import { availableParallelism } from 'node:os';
import type { LoggerService } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ClusterLike,
  ClusterSupervisor,
  type ClusterWorkerLike,
  resolveWorkerCount,
  runClustered,
} from './run-clustered.js';

describe('runClustered', () => {
  it('with one worker just runs bootstrap in this process (no fork)', async () => {
    const bootstrap = vi.fn(() => Promise.resolve());
    await runClustered(bootstrap, { workers: 1 });
    expect(bootstrap).toHaveBeenCalledOnce();
  });

  it('propagates bootstrap failures', async () => {
    await expect(
      runClustered(() => Promise.reject(new Error('boot failed')), { workers: 1 }),
    ).rejects.toThrow('boot failed');
  });

  it('reads CLUSTER_WORKERS (default 1) when no worker count is given', async () => {
    const bootstrap = vi.fn(() => Promise.resolve());
    await runClustered(bootstrap);
    expect(bootstrap).toHaveBeenCalledOnce();
  });
});

describe('resolveWorkerCount', () => {
  it('maps 0 to one worker per core', () => {
    expect(resolveWorkerCount(0)).toBe(availableParallelism());
    expect(resolveWorkerCount(3)).toBe(3);
  });
});

/** In-memory stand-in for node:cluster: workers are records, exits are emitted by the test. */
class FakeCluster extends EventEmitter implements ClusterLike {
  readonly forked: (ClusterWorkerLike & { signals: string[] })[] = [];
  private nextId = 1;

  fork(): ClusterWorkerLike {
    const signals: string[] = [];
    const worker = {
      id: this.nextId++,
      signals,
      process: {
        pid: 1000 + this.nextId,
        kill: (signal?: NodeJS.Signals) => {
          signals.push(signal ?? 'SIGTERM');
          return true;
        },
      },
    };
    this.forked.push(worker);
    return worker;
  }

  exit(worker: ClusterWorkerLike, code: number | null, signal: string | null = null): void {
    this.emit('exit', worker, code, signal);
  }
}

describe('ClusterSupervisor', () => {
  let fakeCluster: FakeCluster;
  let signals: EventEmitter;
  let logger: LoggerService;

  const supervise = (workers = 2): { supervisor: ClusterSupervisor; done: Promise<void> } => {
    const supervisor = new ClusterSupervisor(
      {
        workers,
        logger,
        shutdownTimeoutMs: 5_000,
        minRestartDelayMs: 1_000,
        maxRestartDelayMs: 8_000,
      },
      fakeCluster,
      signals,
    );
    return { supervisor, done: supervisor.run() };
  };

  beforeEach(() => {
    vi.useFakeTimers();
    fakeCluster = new FakeCluster();
    signals = new EventEmitter();
    logger = { log: vi.fn(), error: vi.fn(), warn: vi.fn() };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('forks the configured number of workers', () => {
    const { supervisor } = supervise(3);
    expect(fakeCluster.forked).toHaveLength(3);
    expect(supervisor.size).toBe(3);
  });

  it('restarts a crashed worker with exponential backoff', () => {
    supervise(1);
    const first = fakeCluster.forked[0] as ClusterWorkerLike;
    fakeCluster.exit(first, 1);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('restarting in 1000 ms'));

    vi.advanceTimersByTime(999);
    expect(fakeCluster.forked).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(fakeCluster.forked).toHaveLength(2);

    // Crashing again right away doubles the delay (crash loop protection).
    fakeCluster.exit(fakeCluster.forked[1] as ClusterWorkerLike, null, 'SIGSEGV');
    expect(logger.error).toHaveBeenLastCalledWith(expect.stringContaining('restarting in 2000 ms'));
  });

  it('forwards SIGTERM to every worker and resolves once all exited', async () => {
    const { done, supervisor } = supervise(2);
    signals.emit('SIGTERM', 'SIGTERM');

    expect(fakeCluster.forked.map((worker) => worker.signals)).toEqual([['SIGTERM'], ['SIGTERM']]);
    for (const worker of fakeCluster.forked) fakeCluster.exit(worker, 0);

    await expect(done).resolves.toBeUndefined();
    expect(supervisor.size).toBe(0);
  });

  it('does not restart workers that exit during shutdown, and SIGKILLs stragglers', async () => {
    const { done } = supervise(2);
    signals.emit('SIGINT', 'SIGINT');
    const [first, second] = fakeCluster.forked;
    fakeCluster.exit(first as ClusterWorkerLike, 0);

    vi.advanceTimersByTime(5_000);
    expect(second?.signals).toEqual(['SIGINT', 'SIGKILL']);
    expect(fakeCluster.forked).toHaveLength(2);

    fakeCluster.exit(second as ClusterWorkerLike, null, 'SIGKILL');
    await expect(done).resolves.toBeUndefined();
  });
});

import cluster from 'node:cluster';
import { availableParallelism } from 'node:os';
import { computeBackoffDelay } from '@app/common';
import { appConfig } from '@app/config';
import { createStandaloneLogger, enableClusterMetricsAggregation } from '@app/observability';
import type { LoggerService } from '@nestjs/common';
import { once, times } from 'lodash-es';

export interface RunClusteredOptions {
  /** Worker count; `0` = one per core. Default `CLUSTER_WORKERS` (`appConfig.clusterWorkers`). */
  workers?: number;
  /** Logger of the PRIMARY process (default: pino JSON, context `Cluster`). */
  logger?: LoggerService;
  /**
   * After forwarding SIGTERM/SIGINT, SIGKILL workers still alive after this long (ms). Default
   * `SHUTDOWN_TIMEOUT_MS` + 5 s, so a worker's own forced-exit timer normally wins.
   */
  shutdownTimeoutMs?: number;
  /** Restart backoff after a crash: `minMs` doubling up to `maxMs`. Default 1 s → 30 s. */
  restartDelay?: { minMs?: number; maxMs?: number };
}

/** The parts of a `node:cluster` worker the supervisor uses. */
export interface ClusterWorkerLike {
  readonly id: number;
  readonly process: { readonly pid?: number | undefined; kill(signal?: NodeJS.Signals): boolean };
}

/** The parts of `node:cluster` the supervisor uses (injectable for tests). */
export interface ClusterLike {
  fork(): ClusterWorkerLike;
  on(
    event: 'exit',
    listener: (worker: ClusterWorkerLike, code: number | null, signal: string | null) => void,
  ): unknown;
}

/** Where shutdown signals come from (`process` in production). */
export interface SignalSource {
  once(signal: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): unknown;
}

export interface SupervisorSettings {
  workers: number;
  logger: LoggerService;
  shutdownTimeoutMs: number;
  minRestartDelayMs: number;
  maxRestartDelayMs: number;
}

/** A worker that ran at least this long before dying is "stable": its crash resets the backoff. */
const STABLE_UPTIME_MS = 60_000;
const SHUTDOWN_GRACE_MARGIN_MS = 5_000;
const DEFAULT_MIN_RESTART_DELAY_MS = 1_000;
const DEFAULT_MAX_RESTART_DELAY_MS = 30_000;
const FORWARDED_SIGNALS: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];

/** `0` → one worker per available core (cgroup-aware `os.availableParallelism()`). */
export function resolveWorkerCount(configured: number): number {
  return configured === 0 ? availableParallelism() : configured;
}

interface LiveWorker {
  worker: ClusterWorkerLike;
  forkedAt: number;
}

/**
 * Primary-side worker supervision: forks N workers, restarts crashed ones with capped exponential
 * backoff (a crash loop can't fork-bomb the host), forwards SIGTERM/SIGINT so every worker runs
 * its own graceful Nest shutdown, SIGKILLs stragglers after a deadline and resolves once all
 * workers are gone.
 */
export class ClusterSupervisor {
  private readonly live = new Map<number, LiveWorker>();
  private consecutiveCrashes = 0;
  private shuttingDown = false;
  private resolveDone: (() => void) | undefined;

  constructor(
    private readonly settings: SupervisorSettings,
    private readonly clusterApi: ClusterLike,
    private readonly signals: SignalSource,
  ) {}

  /** Number of workers currently alive. */
  get size(): number {
    return this.live.size;
  }

  /** Forks the workers; resolves once all of them exited after a shutdown signal. */
  run(): Promise<void> {
    const done = new Promise<void>((resolve) => {
      this.resolveDone = resolve;
    });
    this.clusterApi.on('exit', (worker, code, signal) => this.onExit(worker, code, signal));
    for (const signal of FORWARDED_SIGNALS) {
      this.signals.once(signal, (received) => this.shutdown(received));
    }
    times(this.settings.workers, () => this.fork());
    this.settings.logger.log(`Primary ${process.pid} started ${this.settings.workers} workers`);
    return done;
  }

  private fork(): void {
    const worker = this.clusterApi.fork();
    this.live.set(worker.id, { worker, forkedAt: Date.now() });
  }

  private onExit(worker: ClusterWorkerLike, code: number | null, signal: string | null): void {
    const forkedAt = this.live.get(worker.id)?.forkedAt ?? Date.now();
    this.live.delete(worker.id);
    const name = `Worker ${worker.process.pid ?? worker.id}`;
    const reason = signal ?? `code ${code ?? 'unknown'}`;

    if (this.shuttingDown) {
      this.settings.logger.log(`${name} stopped (${reason})`);
      if (this.live.size === 0) this.finish();
      return;
    }

    this.consecutiveCrashes =
      Date.now() - forkedAt >= STABLE_UPTIME_MS ? 1 : this.consecutiveCrashes + 1;
    const delayMs = computeBackoffDelay(this.consecutiveCrashes, {
      minDelayMs: this.settings.minRestartDelayMs,
      maxDelayMs: this.settings.maxRestartDelayMs,
      jitter: false,
    });
    this.settings.logger.error(`${name} died (${reason}); restarting in ${delayMs} ms`);
    setTimeout(() => {
      if (!this.shuttingDown) this.fork();
    }, delayMs);
  }

  private shutdown(signal: NodeJS.Signals): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.settings.logger.log(`${signal} received; stopping ${this.live.size} workers`);
    if (this.live.size === 0) {
      this.finish();
      return;
    }
    for (const { worker } of this.live.values()) worker.process.kill(signal);
    const deadline = setTimeout(() => {
      this.settings.logger.error(
        `${this.live.size} workers still running after ${this.settings.shutdownTimeoutMs} ms; sending SIGKILL`,
      );
      for (const { worker } of this.live.values()) worker.process.kill('SIGKILL');
    }, this.settings.shutdownTimeoutMs);
    deadline.unref();
  }

  private finish(): void {
    this.settings.logger.log('All workers stopped');
    this.resolveDone?.();
  }
}

/**
 * Runs `bootstrap` in a node:cluster (vertical scaling on VMs / bare metal). With one worker —
 * the default, and the right choice under Kubernetes, which scales by pods — it simply awaits
 * `bootstrap()` in this process. Otherwise the primary only supervises (it never boots Nest) and
 * aggregates `/metrics` across workers; each worker runs `bootstrap()`.
 *
 * Config is read with `appConfig.parse()` (no Nest in the primary). Start with
 * `node --import ./dist/instrument.js dist/main.js`: workers inherit `execArgv`, so each gets the
 * tracing preload too.
 */
export async function runClustered(
  bootstrap: () => Promise<void>,
  options: RunClusteredOptions = {},
): Promise<void> {
  if (cluster.isWorker) {
    await bootstrap();
    return;
  }
  // Parsed only when an option doesn't supply the value (keeps explicit options env-independent).
  const config = once(() => appConfig.parse());
  const workers = resolveWorkerCount(options.workers ?? config().clusterWorkers);
  if (workers <= 1) {
    await bootstrap();
    return;
  }

  enableClusterMetricsAggregation();
  const supervisor = new ClusterSupervisor(
    {
      workers,
      logger: options.logger ?? createStandaloneLogger('Cluster'),
      shutdownTimeoutMs:
        options.shutdownTimeoutMs ?? config().shutdownTimeoutMs + SHUTDOWN_GRACE_MARGIN_MS,
      minRestartDelayMs: options.restartDelay?.minMs ?? DEFAULT_MIN_RESTART_DELAY_MS,
      maxRestartDelayMs: options.restartDelay?.maxMs ?? DEFAULT_MAX_RESTART_DELAY_MS,
    },
    cluster,
    process,
  );
  await supervisor.run();
}

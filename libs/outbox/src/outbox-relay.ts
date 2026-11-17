import {
  type BeforeApplicationShutdown,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { SystemContext } from '@platform/common';
import type { OutboxConfig } from '@platform/config';
import type { DistributedLockService } from '@platform/redis';
import type { KafkaProducer } from '@platform/transport';
import type { OutboxSystemRepository } from './outbox.system-repository.js';
import type { OutboxFeature, OutboxRow } from './outbox.types.js';

/** The `SystemContext` reason of every repository call the relay makes (poll, mark, purge). */
export const OUTBOX_RELAY_REASON = 'outbox.relay';

/** The retention purge runs at most once per this much leadership (and when a term starts). */
export const OUTBOX_PURGE_INTERVAL_MS = 3_600_000;

/** The Redis lock resource whose holder is the one publishing relay of an outbox. */
export const outboxRelayLockResource = (name: string): string => `outbox-relay:${name}`;

/** What the relay needs of the domain's system repository (the in-memory fake fits too). */
export type OutboxRelayRepository = Pick<
  OutboxSystemRepository,
  'pollUnpublished' | 'markPublished' | 'deletePublishedBefore'
>;

/** What the relay needs of `DistributedLockService`. */
export type OutboxRelayLock = Pick<DistributedLockService, 'using'>;

/** What the relay needs of `KafkaProducer`. */
export type OutboxRelayPublisher = Pick<KafkaProducer, 'publishStored'>;

export interface OutboxRelayOptions {
  /** Whether the process has a system pool (DATABASE_SYSTEM_URL); without one the relay never starts. */
  readonly systemPool: boolean;
  /** Jitter source in [0, 1). Default `Math.random`. */
  readonly random?: () => number;
}

/** One poll → publish → mark cycle. */
export interface OutboxTickResult {
  /** Rows the poll returned. */
  readonly polled: number;
  /** Rows the broker acknowledged (marked, unless `markPublished` failed). */
  readonly published: number;
  /** A publish, the poll or the mark failed: the relay backs off and the rows go out again. */
  readonly failed: boolean;
}

export type OutboxTermOutcome = 'not-leader' | 'lost' | 'stopped';

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Resolves after `ms`, or at once when `signal` aborts (never rejects). */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * The relay of one outbox (SH §7.4): every process that owns the outbox runs one, and only the
 * holder of the Redis lock `outbox-relay:<name>` publishes. Delivery is at least once:
 * - A term is one `DistributedLockService.using(lock, lockTtlMs, …)`; the lock's auto-extension
 *   renews the TTL while the term runs. Not acquired → `'not-leader'`, and the next attempt comes
 *   after `pollIntervalMs` with jitter. When the lock's signal aborts the term stops before the
 *   next publish (`'lost'`); the stop signal ends it the same way (`'stopped'`).
 * - A tick (inside `SystemContext.run('outbox.relay', …)`) polls `batchSize` rows, publishes them
 *   one by one in poll order with `publishStored`, then marks the rows whose publish resolved.
 *   Every repository call is its own statement on the system pool: no Postgres transaction is
 *   open while a publish is in flight, and none overlaps a publish.
 * - The first failed publish ends the batch: the earlier rows are marked, the failed row and the
 *   later ones stay and go out again (a row the producer always refuses blocks the outbox until an
 *   operator acts). A failed poll or mark is logged (and counted by the system pool as an `error`
 *   call); those rows go out again too. After any failure the wait doubles, from
 *   2 × `pollIntervalMs` up to `maxBackoffMs`; a clean tick resets it.
 * - A full batch polls again at once; otherwise the relay waits `pollIntervalMs`.
 * - Once per hour of leadership (and at the start of the first term) it purges the rows published
 *   more than `retentionHours` ago.
 * - Starts on application bootstrap when `relayEnabled` and the process has a system pool; stops
 *   in `beforeApplicationShutdown` (before Redis, the pools and the Kafka client close), waiting
 *   for the in-flight publish at most `lockTtlMs`.
 */
export class OutboxRelay implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger: Logger;
  private readonly lockResource: string;
  private readonly random: () => number;
  /** Epoch ms from which the next purge is due; shared by the terms of this instance. */
  private nextPurgeAt = 0;
  private stopController: AbortController | undefined;
  private running: Promise<void> | undefined;

  constructor(
    feature: OutboxFeature,
    private readonly repository: OutboxRelayRepository,
    private readonly publisher: OutboxRelayPublisher,
    private readonly lock: OutboxRelayLock,
    private readonly config: OutboxConfig,
    private readonly options: OutboxRelayOptions,
  ) {
    this.logger = new Logger(`OutboxRelay:${feature.name}`);
    this.lockResource = outboxRelayLockResource(feature.name);
    this.random = options.random ?? Math.random;
  }

  /**
   * One poll → publish → mark cycle; never rejects. Publishing stops before the next row once
   * `signal` aborts; the rows already acknowledged are still marked.
   */
  tick(signal: AbortSignal): Promise<OutboxTickResult> {
    return SystemContext.run(OUTBOX_RELAY_REASON, async (): Promise<OutboxTickResult> => {
      if (signal.aborted) return { polled: 0, published: 0, failed: false };
      let rows: readonly OutboxRow[];
      try {
        ({ rows } = await this.repository.pollUnpublished(this.config.batchSize));
      } catch (error) {
        this.logger.warn(`poll failed (${errorMessage(error)}); retrying after a backoff`);
        return { polled: 0, published: 0, failed: true };
      }
      const acknowledged: OutboxRow[] = [];
      let failed = false;
      for (const row of rows) {
        if (signal.aborted) break;
        try {
          await this.publisher.publishStored(row.topic, row.envelope, row.key);
          acknowledged.push(row);
        } catch (error) {
          failed = true;
          this.logger.warn(
            `publish of event ${row.id} to "${row.topic}" failed (${errorMessage(error)}); ` +
              'the batch stops here and the row goes out again',
          );
          break;
        }
      }
      if (acknowledged.length > 0) {
        try {
          await this.repository.markPublished(
            acknowledged.map(({ tenantId, id }) => ({ tenantId, id })),
          );
        } catch (error) {
          failed = true;
          this.logger.warn(
            `marking ${acknowledged.length} published rows failed (${errorMessage(error)}); ` +
              'they go out again',
          );
        }
      }
      return { polled: rows.length, published: acknowledged.length, failed };
    });
  }

  /**
   * One term on the lock `outbox-relay:<name>`: ticks until the lock is lost (`'lost'`) or `stop`
   * aborts (`'stopped'`); `'not-leader'` when the lock is held elsewhere or Redis is unreachable.
   */
  async runTerm(stop: AbortSignal): Promise<OutboxTermOutcome> {
    if (stop.aborted) return 'stopped';
    const outcome = await this.lock.using(this.lockResource, this.config.lockTtlMs, (lost) =>
      this.term(stop, lost),
    );
    return outcome.acquired ? outcome.result : 'not-leader';
  }

  onApplicationBootstrap(): void {
    if (!this.config.relayEnabled) {
      this.logger.log('relay disabled (OUTBOX_RELAY_ENABLED=false)');
      return;
    }
    if (!this.options.systemPool) {
      this.logger.warn('no system pool (DATABASE_SYSTEM_URL is not set): the relay does not start');
      return;
    }
    if (this.running !== undefined) return;
    const controller = new AbortController();
    this.stopController = controller;
    this.running = this.run(controller.signal).catch((error: unknown) => {
      this.logger.error(`relay loop ended unexpectedly (${errorMessage(error)})`);
    });
  }

  /** Aborts the term and waits for the in-flight publish (and its mark), at most `lockTtlMs`. */
  async beforeApplicationShutdown(): Promise<void> {
    const running = this.running;
    if (running === undefined) return;
    this.stopController?.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), this.config.lockTtlMs);
    });
    try {
      const expired = await Promise.race([running.then(() => false), timedOut]);
      if (expired) {
        this.logger.warn(
          `stopped waiting for the in-flight publish after ${this.config.lockTtlMs}ms`,
        );
      }
    } finally {
      clearTimeout(timer);
      this.running = undefined;
      this.stopController = undefined;
    }
  }

  /** Terms back to back until `stop` aborts; between two terms, the jittered poll interval. */
  private async run(stop: AbortSignal): Promise<void> {
    while (!stop.aborted) {
      let outcome: OutboxTermOutcome;
      try {
        outcome = await this.runTerm(stop);
      } catch (error) {
        this.logger.error(`term failed (${errorMessage(error)})`);
        outcome = 'lost';
      }
      if (outcome === 'stopped') return;
      if (outcome === 'lost') this.logger.warn('lost the relay lock; trying to take it again');
      await wait(this.jitteredInterval(), stop);
    }
  }

  private async term(stop: AbortSignal, lost: AbortSignal): Promise<'lost' | 'stopped'> {
    this.logger.log('leading: publishing this outbox');
    const signal = AbortSignal.any([stop, lost]);
    let failures = 0;
    for (;;) {
      if (stop.aborted) return 'stopped';
      if (lost.aborted) return 'lost';
      await this.purgeIfDue();
      if (signal.aborted) continue;
      const result = await this.tick(signal);
      failures = result.failed ? failures + 1 : 0;
      const delay = result.failed
        ? this.backoff(failures)
        : result.polled >= this.config.batchSize
          ? 0
          : this.config.pollIntervalMs;
      if (delay > 0) await wait(delay, signal);
    }
  }

  /** The wait after the `failures`-th failed tick in a row: doubling, capped at `maxBackoffMs`. */
  private backoff(failures: number): number {
    const exponent = Math.min(failures, 30);
    return Math.min(this.config.pollIntervalMs * 2 ** exponent, this.config.maxBackoffMs);
  }

  /** `pollIntervalMs` × [0.75, 1.25): spreads the lock attempts of the followers. */
  private jitteredInterval(): number {
    return Math.round(this.config.pollIntervalMs * (0.75 + this.random() * 0.5));
  }

  /** Deletes rows published before now − `retentionHours`, at most once per hour; never throws. */
  private async purgeIfDue(): Promise<void> {
    const now = Date.now();
    if (now < this.nextPurgeAt) return;
    this.nextPurgeAt = now + OUTBOX_PURGE_INTERVAL_MS;
    const cutoff = new Date(now - this.config.retentionHours * 3_600_000);
    try {
      const deleted = await SystemContext.run(OUTBOX_RELAY_REASON, () =>
        this.repository.deletePublishedBefore(cutoff),
      );
      if (deleted > 0)
        this.logger.log(`purged ${deleted} rows published before ${cutoff.toISOString()}`);
    } catch (error) {
      this.logger.warn(`purge failed (${errorMessage(error)}); next attempt in an hour`);
    }
  }
}

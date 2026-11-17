import { createPrincipal, generateId, runWithPrincipal, SystemContext } from '@platform/common';
import type { OutboxConfig } from '@platform/config';
import type { EventEnvelope } from '@platform/contracts';
import type { LockResult } from '@platform/redis';
import { FakeKafkaProducer } from '@platform/transport/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FX_OUTBOX, ORDER_PLACED_EVENT, orderPlaced } from '../test/outbox-fixture.js';
import {
  OUTBOX_PURGE_INTERVAL_MS,
  OUTBOX_RELAY_REASON,
  OutboxRelay,
  type OutboxRelayLock,
  type OutboxRelayOptions,
  outboxRelayLockResource,
} from './outbox-relay.js';
import { InMemoryOutbox } from './testing/in-memory-outbox.js';

const TENANTS = [
  '0197a000-0000-7000-8000-0000000000a1',
  '0197a000-0000-7000-8000-0000000000b2',
  '0197a000-0000-7000-8000-0000000000c3',
] as const;
const START = Date.parse('2026-09-01T10:00:00.000Z');
const HOUR_MS = 3_600_000;

const config = (overrides: Partial<OutboxConfig> = {}): OutboxConfig => ({
  relayEnabled: true,
  pollIntervalMs: 100,
  batchSize: 10,
  lockTtlMs: 2_000,
  maxBackoffMs: 800,
  retentionHours: 168,
  ...overrides,
});

/** A lock that is granted (or not) on demand; `lose()` aborts the current holder's signal. */
class FakeLock implements OutboxRelayLock {
  mode: 'acquire' | 'held' | 'error' = 'acquire';
  readonly resources: string[] = [];
  readonly ttls: number[] = [];
  private controller = new AbortController();

  async using<T>(
    resource: string,
    ttlMs: number,
    fn: (signal: AbortSignal) => Promise<T>,
  ): Promise<LockResult<T>> {
    this.resources.push(resource);
    this.ttls.push(ttlMs);
    if (this.mode !== 'acquire') return { acquired: false, reason: this.mode };
    this.controller = new AbortController();
    return { acquired: true, result: await fn(this.controller.signal) };
  }

  lose(): void {
    this.controller.abort();
  }
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** Lets pending promise callbacks run (no timers involved). */
const flush = async (rounds = 20): Promise<void> => {
  for (let round = 0; round < rounds; round += 1) await Promise.resolve();
};

describe('OutboxRelay', () => {
  let clock: number;
  let outbox: InMemoryOutbox;
  let kafka: FakeKafkaProducer;
  let lock: FakeLock;
  /** Envelope ids in the order publishStored was called (also for publishes that failed). */
  let attempts: string[];
  /** Envelope ids whose publish the broker acknowledged. */
  let acknowledged: string[];
  /** Per-call behaviour of publishStored: return a promise to delay or fail that publish. */
  let onPublish: (envelopeId: string, index: number) => Promise<void> | undefined;
  /** Publishes in flight right now. */
  let inFlight: number;

  const relayWith = (
    overrides: Partial<OutboxConfig> = {},
    options: Partial<OutboxRelayOptions> = {},
  ): OutboxRelay =>
    new OutboxRelay(FX_OUTBOX, outbox, kafka, lock, config(overrides), {
      systemPool: true,
      random: () => 0.5,
      ...options,
    });

  /** Enqueues `count` rows, one millisecond apart, spread over three tenants. */
  const seed = async (count: number): Promise<string[]> => {
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      clock += 1;
      const principal = createPrincipal({
        userId: generateId(),
        tenantId: TENANTS[index % TENANTS.length] ?? null,
        roles: ['member'],
      });
      const envelope = await runWithPrincipal(principal, () =>
        outbox.enqueue(ORDER_PLACED_EVENT, orderPlaced()),
      );
      ids.push(envelope.id);
    }
    return ids;
  };

  const publishedIds = (): string[] =>
    outbox.records.flatMap((row) => (row.publishedAt ? [row.id] : []));
  const unpublishedIds = (): string[] => outbox.unpublished().map((row) => row.id);
  const kafkaIds = (): string[] => kafka.records.map((record) => record.value.id);

  beforeEach(() => {
    clock = START;
    kafka = new FakeKafkaProducer({ source: 'fx-service' });
    outbox = new InMemoryOutbox(FX_OUTBOX, { kafka, now: () => new Date(clock) });
    lock = new FakeLock();
    attempts = [];
    acknowledged = [];
    inFlight = 0;
    onPublish = () => undefined;
    const send = kafka.publishStored.bind(kafka);
    vi.spyOn(kafka, 'publishStored').mockImplementation(
      async (topic: string, envelope: EventEnvelope<unknown>, key: string | null) => {
        const index = attempts.length;
        attempts.push(envelope.id);
        inFlight += 1;
        try {
          await onPublish(envelope.id, index);
          await send(topic, envelope, key);
          acknowledged.push(envelope.id);
        } finally {
          inFlight -= 1;
        }
      },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('tick()', () => {
    it('publishes the polled rows one by one in poll order, then marks them', async () => {
      const ids = await seed(5);
      const relay = relayWith();
      const result = await relay.tick(new AbortController().signal);

      expect(result).toEqual({ polled: 5, published: 5, failed: false });
      expect(attempts).toEqual(ids);
      expect(kafka.records.map((record) => record.topic)).toEqual(
        Array(5).fill(ORDER_PLACED_EVENT.topic),
      );
      expect(kafkaIds()).toEqual(ids);
      expect(publishedIds()).toEqual(ids);
      // The stored envelope goes out unchanged, with its key.
      const stored = outbox.records[0];
      expect(kafka.records[0]?.value).toEqual(stored?.envelope);
      expect(kafka.records[0]?.key).toBe(stored?.key);
    });

    it('marks a row only after its publish resolved', async () => {
      const ids = await seed(3);
      const gate = deferred();
      onPublish = (_id, index) => (index === 1 ? gate.promise : undefined);
      const relay = relayWith();
      const tick = relay.tick(new AbortController().signal);
      await flush();

      expect(attempts).toEqual(ids.slice(0, 2));
      expect(publishedIds()).toEqual([]);
      gate.resolve();
      await expect(tick).resolves.toEqual({ polled: 3, published: 3, failed: false });
      expect(publishedIds()).toEqual(ids);
    });

    it('ends the batch at the first failed publish: earlier rows marked, k..n not, next tick starts at k', async () => {
      const ids = await seed(6);
      onPublish = (_id, index) =>
        index === 3 ? Promise.reject(new Error('broker unavailable')) : undefined;
      const relay = relayWith();

      await expect(relay.tick(new AbortController().signal)).resolves.toEqual({
        polled: 6,
        published: 3,
        failed: true,
      });
      expect(attempts).toEqual(ids.slice(0, 4));
      expect(publishedIds()).toEqual(ids.slice(0, 3));
      expect(unpublishedIds()).toEqual(ids.slice(3));

      attempts = [];
      onPublish = () => undefined;
      await expect(relay.tick(new AbortController().signal)).resolves.toEqual({
        polled: 3,
        published: 3,
        failed: false,
      });
      expect(attempts).toEqual(ids.slice(3));
      expect(publishedIds()).toEqual(ids);
    });

    it('treats a stored envelope the producer refuses like any failed publish (the row blocks)', async () => {
      const ids = await seed(2);
      const second = outbox.records[1];
      if (second === undefined) throw new Error('seed failed');
      Object.assign(second, { topic: 'fx.other-topic.v1' }); // envelope.type !== topic
      const relay = relayWith();

      await expect(relay.tick(new AbortController().signal)).resolves.toEqual({
        polled: 2,
        published: 1,
        failed: true,
      });
      expect(publishedIds()).toEqual(ids.slice(0, 1));
      expect(unpublishedIds()).toEqual(ids.slice(1));
    });

    it('resolves when markPublished rejects; the same envelope ids go out again on the next tick', async () => {
      const ids = await seed(3);
      const mark = vi
        .spyOn(outbox, 'markPublished')
        .mockRejectedValueOnce(new Error('connection terminated'));
      const relay = relayWith();

      await expect(relay.tick(new AbortController().signal)).resolves.toEqual({
        polled: 3,
        published: 3,
        failed: true,
      });
      expect(mark).toHaveBeenCalledTimes(1);
      expect(unpublishedIds()).toEqual(ids);

      await expect(relay.tick(new AbortController().signal)).resolves.toEqual({
        polled: 3,
        published: 3,
        failed: false,
      });
      expect(kafkaIds()).toEqual([...ids, ...ids]);
      expect(publishedIds()).toEqual(ids);
    });

    it('resolves when the poll rejects, publishing nothing', async () => {
      await seed(2);
      vi.spyOn(outbox, 'pollUnpublished').mockRejectedValueOnce(new Error('statement timeout'));
      const relay = relayWith();

      await expect(relay.tick(new AbortController().signal)).resolves.toEqual({
        polled: 0,
        published: 0,
        failed: true,
      });
      expect(attempts).toEqual([]);
    });

    it('stops publishing once the signal aborts and still marks what the broker acknowledged', async () => {
      const ids = await seed(5);
      const stop = new AbortController();
      onPublish = (_id, index) => {
        if (index === 2) stop.abort();
        return undefined;
      };
      const relay = relayWith();

      await expect(relay.tick(stop.signal)).resolves.toEqual({
        polled: 5,
        published: 3,
        failed: false,
      });
      expect(attempts).toEqual(ids.slice(0, 3));
      expect(publishedIds()).toEqual(ids.slice(0, 3));
    });

    it('runs every repository call inside SystemContext with reason outbox.relay, never during a publish', async () => {
      await seed(4);
      const seen: { method: string; reason: string | undefined; inFlight: number }[] = [];
      for (const method of ['pollUnpublished', 'markPublished', 'deletePublishedBefore'] as const) {
        const original = outbox[method].bind(outbox) as (...args: unknown[]) => Promise<unknown>;
        vi.spyOn(outbox, method).mockImplementation((async (...args: unknown[]) => {
          seen.push({ method, reason: SystemContext.current()?.reason, inFlight });
          return original(...args);
        }) as never);
      }
      onPublish = () => new Promise<void>((resolve) => setImmediate(resolve));
      const relay = relayWith({ batchSize: 4 });
      const term = relay.runTerm(new AbortController().signal);
      await vi.waitFor(() => expect(publishedIds()).toHaveLength(4));
      lock.lose();
      await expect(term).resolves.toBe('lost');

      expect(seen.map(({ method }) => method)).toEqual(
        expect.arrayContaining(['deletePublishedBefore', 'pollUnpublished', 'markPublished']),
      );
      expect(seen.every(({ reason }) => reason === OUTBOX_RELAY_REASON)).toBe(true);
      expect(OUTBOX_RELAY_REASON).toBe('outbox.relay');
      expect(seen.every(({ inFlight: publishing }) => publishing === 0)).toBe(true);
    });
  });

  describe('runTerm()', () => {
    beforeEach(() => {
      vi.useFakeTimers({ now: START });
    });

    it('holds the lock outbox-relay:<name> with the configured TTL', async () => {
      const relay = relayWith();
      const stop = new AbortController();
      const term = relay.runTerm(stop.signal);
      await vi.advanceTimersByTimeAsync(0);
      stop.abort();
      await expect(term).resolves.toBe('stopped');
      expect(lock.resources).toEqual(['outbox-relay:fx']);
      expect(outboxRelayLockResource('fx')).toBe('outbox-relay:fx');
      expect(lock.ttls).toEqual([2_000]);
    });

    it.each(['held', 'error'] as const)(
      'returns not-leader when the lock is %s and never calls the repository',
      async (mode) => {
        await seed(2);
        lock.mode = mode;
        const calls = [
          vi.spyOn(outbox, 'pollUnpublished'),
          vi.spyOn(outbox, 'markPublished'),
          vi.spyOn(outbox, 'deletePublishedBefore'),
        ];
        const relay = relayWith();
        await expect(relay.runTerm(new AbortController().signal)).resolves.toBe('not-leader');
        for (const call of calls) expect(call).not.toHaveBeenCalled();
        expect(attempts).toEqual([]);
      },
    );

    it('polls again at once after a full batch and waits pollIntervalMs after an empty poll', async () => {
      const ids = await seed(5);
      const pollTimes: number[] = [];
      const poll = outbox.pollUnpublished.bind(outbox);
      vi.spyOn(outbox, 'pollUnpublished').mockImplementation(async (limit) => {
        pollTimes.push(Date.now() - START);
        return poll(limit);
      });
      const relay = relayWith({ batchSize: 2 });
      const stop = new AbortController();
      const term = relay.runTerm(stop.signal);

      await vi.advanceTimersByTimeAsync(250);
      stop.abort();
      await expect(term).resolves.toBe('stopped');
      // 2 + 2 (full) at once, 1 (partial) → wait, empty → wait, empty → wait …
      expect(pollTimes).toEqual([0, 0, 0, 100, 200]);
      expect(publishedIds()).toEqual(ids);
    });

    it('doubles the wait after each failed tick up to maxBackoffMs and resets it after a clean tick', async () => {
      const ids = await seed(1);
      const pollTimes: number[] = [];
      const poll = outbox.pollUnpublished.bind(outbox);
      vi.spyOn(outbox, 'pollUnpublished').mockImplementation(async (limit) => {
        pollTimes.push(Date.now() - START);
        return poll(limit);
      });
      let failing = true;
      onPublish = () => (failing ? Promise.reject(new Error('broker unavailable')) : undefined);
      const relay = relayWith({ pollIntervalMs: 100, maxBackoffMs: 800 });
      const stop = new AbortController();
      const term = relay.runTerm(stop.signal);

      // Failures at 0, 200, 600, 1400 (capped), 2200 (capped).
      await vi.advanceTimersByTimeAsync(2_200);
      expect(pollTimes).toEqual([0, 200, 600, 1_400, 2_200]);
      failing = false;
      // 3000: clean (row published, partial batch) → 3100: empty → 3200 …
      await vi.advanceTimersByTimeAsync(1_000);
      expect(pollTimes.slice(5)).toEqual([3_000, 3_100, 3_200]);
      expect(publishedIds()).toEqual(ids);

      // A new failure starts again from the first step.
      pollTimes.length = 0;
      await seed(1);
      failing = true;
      await vi.advanceTimersByTimeAsync(100); // 3300: fails
      await vi.advanceTimersByTimeAsync(200); // 3500: fails again
      expect(pollTimes).toEqual([3_300, 3_500]);
      stop.abort();
      await expect(term).resolves.toBe('stopped');
    });

    it('a throwing poll does not end the term: it backs off and publishes on a later tick', async () => {
      const ids = await seed(2);
      vi.spyOn(outbox, 'pollUnpublished')
        .mockRejectedValueOnce(new Error('statement timeout'))
        .mockRejectedValueOnce(new Error('statement timeout'));
      const relay = relayWith();
      const stop = new AbortController();
      const term = relay.runTerm(stop.signal);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(publishedIds()).toEqual(ids);
      stop.abort();
      await expect(term).resolves.toBe('stopped');
    });

    it('returns lost when the lock signal aborts mid-batch: no further publish, acknowledged rows marked', async () => {
      const ids = await seed(5);
      onPublish = (_id, index) => {
        if (index === 1) lock.lose();
        return undefined;
      };
      const relay = relayWith();

      await expect(relay.runTerm(new AbortController().signal)).resolves.toBe('lost');
      expect(attempts).toEqual(ids.slice(0, 2));
      expect(publishedIds()).toEqual(ids.slice(0, 2));
    });

    it('purges published rows older than retentionHours once per hour of leadership', async () => {
      const purge = vi.spyOn(outbox, 'deletePublishedBefore');
      // One poll a minute keeps three hours of fake time cheap.
      const relay = relayWith({ retentionHours: 24, pollIntervalMs: 60_000, maxBackoffMs: 60_000 });
      const stop = new AbortController();
      const term = relay.runTerm(stop.signal);

      await vi.advanceTimersByTimeAsync(0);
      expect(purge).toHaveBeenCalledTimes(1);
      expect(purge.mock.calls[0]?.[0]).toEqual(new Date(START - 24 * HOUR_MS));
      await vi.advanceTimersByTimeAsync(OUTBOX_PURGE_INTERVAL_MS - 1_000);
      expect(purge).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(purge).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(2 * HOUR_MS);
      expect(purge).toHaveBeenCalledTimes(4);
      expect(OUTBOX_PURGE_INTERVAL_MS).toBe(HOUR_MS);

      stop.abort();
      await expect(term).resolves.toBe('stopped');
    });

    it('a failing purge does not end the term', async () => {
      const ids = await seed(1);
      vi.spyOn(outbox, 'deletePublishedBefore').mockRejectedValueOnce(new Error('timeout'));
      const relay = relayWith();
      const stop = new AbortController();
      const term = relay.runTerm(stop.signal);

      await vi.advanceTimersByTimeAsync(0);
      expect(publishedIds()).toEqual(ids);
      stop.abort();
      await expect(term).resolves.toBe('stopped');
    });

    it('a stop signal ends a long backoff wait at once', async () => {
      await seed(1);
      onPublish = () => Promise.reject(new Error('broker unavailable'));
      const relay = relayWith({ pollIntervalMs: 1_000, maxBackoffMs: 60_000 });
      const stop = new AbortController();
      const term = relay.runTerm(stop.signal);
      await vi.advanceTimersByTimeAsync(0);
      stop.abort();
      await vi.advanceTimersByTimeAsync(0);
      await expect(term).resolves.toBe('stopped');
    });
  });

  describe('lifecycle', () => {
    beforeEach(() => {
      vi.useFakeTimers({ now: START });
    });

    it('relayEnabled=false: never asks for the lock', async () => {
      const using = vi.spyOn(lock, 'using');
      const relay = relayWith({ relayEnabled: false });
      relay.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(10_000);
      await relay.beforeApplicationShutdown();
      expect(using).not.toHaveBeenCalled();
    });

    it('without a system pool: never asks for the lock and warns once', async () => {
      const using = vi.spyOn(lock, 'using');
      const relay = relayWith({}, { systemPool: false });
      const warn = vi
        .spyOn(
          (relay as unknown as { logger: { warn: (...args: unknown[]) => void } }).logger,
          'warn',
        )
        .mockImplementation(() => undefined);
      relay.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(10_000);
      await relay.beforeApplicationShutdown();
      expect(using).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('starts on bootstrap, publishes, and stops on shutdown', async () => {
      const ids = await seed(3);
      const relay = relayWith();
      relay.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(0);
      expect(publishedIds()).toEqual(ids);
      await relay.beforeApplicationShutdown();
      const calls = lock.resources.length;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(lock.resources).toHaveLength(calls);
    });

    it('retries the lock after pollIntervalMs with jitter while another instance leads', async () => {
      lock.mode = 'held';
      const relay = relayWith({ pollIntervalMs: 100 }, { random: () => 0 });
      relay.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(0);
      expect(lock.resources).toHaveLength(1);
      // random() = 0 → the shortest jittered wait, 0.75 × pollIntervalMs.
      await vi.advanceTimersByTimeAsync(74);
      expect(lock.resources).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(lock.resources).toHaveLength(2);
      lock.mode = 'acquire';
      await vi.advanceTimersByTimeAsync(75);
      expect(lock.resources).toHaveLength(3);
      await relay.beforeApplicationShutdown();
    });

    it('takes leadership again after losing it', async () => {
      const relay = relayWith({ pollIntervalMs: 100 });
      relay.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(0);
      expect(lock.resources).toHaveLength(1);
      lock.lose();
      await vi.advanceTimersByTimeAsync(200);
      expect(lock.resources).toHaveLength(2);
      await relay.beforeApplicationShutdown();
    });

    it('shutdown waits for the in-flight publish, at most lockTtlMs', async () => {
      await seed(2);
      const hang = deferred();
      onPublish = () => hang.promise;
      const relay = relayWith({ lockTtlMs: 2_000 });
      relay.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(1);

      let done = false;
      const shutdown = relay.beforeApplicationShutdown().then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(1_999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await shutdown;
      expect(done).toBe(true);
      expect(attempts).toHaveLength(1);
    });

    it('shutdown returns as soon as the in-flight publish resolves, and marks it', async () => {
      const ids = await seed(2);
      const gate = deferred();
      onPublish = (_id, index) => (index === 0 ? gate.promise : undefined);
      const relay = relayWith({ lockTtlMs: 2_000 });
      relay.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(0);

      const shutdown = relay.beforeApplicationShutdown();
      await vi.advanceTimersByTimeAsync(10);
      gate.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await shutdown;
      expect(attempts).toEqual(ids.slice(0, 1));
      expect(publishedIds()).toEqual(ids.slice(0, 1));
    });
  });
});

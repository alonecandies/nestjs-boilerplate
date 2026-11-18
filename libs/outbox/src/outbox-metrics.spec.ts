import { createPrincipal, generateId, runWithPrincipal } from '@platform/common';
import type { OutboxConfig } from '@platform/config';
import type { EventEnvelope } from '@platform/contracts';
import type { LockResult } from '@platform/redis';
import { FakeKafkaProducer } from '@platform/transport/testing';
import { register } from 'prom-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FX_OUTBOX, fxOutbox, ORDER_PLACED_EVENT, orderPlaced } from '../test/outbox-fixture.js';
import type { OutboxFeature } from './outbox.types.js';
import {
  OUTBOX_BACKLOG,
  OUTBOX_OLDEST_UNPUBLISHED_AGE_SECONDS,
  OUTBOX_PUBLISH_LATENCY_SECONDS,
  OUTBOX_PUBLISHED_TOTAL,
  OUTBOX_RELAY_LEADER,
} from './outbox-metrics.js';
import { OutboxRelay, type OutboxRelayLock } from './outbox-relay.js';
import { InMemoryOutbox } from './testing/in-memory-outbox.js';

const TENANT = '0197a000-0000-7000-8000-0000000000a1';
const START = Date.parse('2026-09-01T10:00:00.000Z');
const TOPIC = ORDER_PLACED_EVENT.topic;

const config = (overrides: Partial<OutboxConfig> = {}): OutboxConfig => ({
  relayEnabled: true,
  pollIntervalMs: 100,
  batchSize: 10,
  lockTtlMs: 2_000,
  maxBackoffMs: 800,
  retentionHours: 168,
  ...overrides,
});

/** A lock that is always granted; `lose()` aborts the current holder's signal. */
class FakeLock implements OutboxRelayLock {
  private controller = new AbortController();

  async using<T>(
    _resource: string,
    _ttlMs: number,
    fn: (signal: AbortSignal) => Promise<T>,
  ): Promise<LockResult<T>> {
    this.controller = new AbortController();
    return { acquired: true, result: await fn(this.controller.signal) };
  }

  lose(): void {
    this.controller.abort();
  }
}

type Sample = { labels: Record<string, string | number>; value: number; metricName?: string };

/** Every sample of `name` in the default registry (what `/metrics` serves). */
async function samples(name: string): Promise<Sample[]> {
  const metric = register.getSingleMetric(name);
  if (metric === undefined) return [];
  return (await metric.get()).values as Sample[];
}

/** The value of the sample whose labels include `labels`; `undefined` when the scrape has none. */
async function value(
  name: string,
  labels: Record<string, string>,
  metricName = name,
): Promise<number | undefined> {
  const found = (await samples(name)).find(
    (sample) =>
      (sample.metricName ?? name) === metricName &&
      Object.entries(labels).every(([key, label]) => sample.labels[key] === label),
  );
  return found?.value;
}

describe('outbox metrics (G-9)', () => {
  let clock: number;
  let lock: FakeLock;

  const setup = (feature: OutboxFeature = FX_OUTBOX) => {
    const kafka = new FakeKafkaProducer({ source: 'fx-service' });
    const outbox = new InMemoryOutbox(feature, { kafka, now: () => new Date(clock) });
    return { kafka, outbox };
  };

  const seed = async (outbox: InMemoryOutbox, count: number): Promise<string[]> => {
    const ids: string[] = [];
    const principal = createPrincipal({
      userId: generateId(),
      tenantId: TENANT,
      roles: ['member'],
    });
    for (let index = 0; index < count; index += 1) {
      clock += 1;
      const envelope = await runWithPrincipal(principal, () =>
        outbox.enqueue(ORDER_PLACED_EVENT, orderPlaced()),
      );
      ids.push(envelope.id);
    }
    return ids;
  };

  beforeEach(() => {
    register.resetMetrics();
    clock = START;
    lock = new FakeLock();
    vi.useFakeTimers({ now: START, toFake: ['Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sets the backlog and the age of the oldest unpublished row from the poll', async () => {
    const { kafka, outbox } = setup();
    await seed(outbox, 7);
    // The oldest row was created at START + 1 ms; the tick runs 30 s later.
    vi.setSystemTime(START + 1 + 30_000);
    const relay = new OutboxRelay(FX_OUTBOX, outbox, kafka, lock, config({ batchSize: 5 }), {
      systemPool: true,
    });

    await expect(relay.tick(new AbortController().signal)).resolves.toMatchObject({
      polled: 5,
      published: 5,
    });

    expect(await value(OUTBOX_BACKLOG, { outbox: 'fx' })).toBe(7);
    const age = await value(OUTBOX_OLDEST_UNPUBLISHED_AGE_SECONDS, { outbox: 'fx' });
    expect(age).toBeGreaterThanOrEqual(29);
    expect(age).toBeLessThanOrEqual(31);
  });

  it('reads 0 and 0 for an empty outbox', async () => {
    const { kafka, outbox } = setup();
    const relay = new OutboxRelay(FX_OUTBOX, outbox, kafka, lock, config(), { systemPool: true });

    await relay.tick(new AbortController().signal);

    expect(await value(OUTBOX_BACKLOG, { outbox: 'fx' })).toBe(0);
    expect(await value(OUTBOX_OLDEST_UNPUBLISHED_AGE_SECONDS, { outbox: 'fx' })).toBe(0);
  });

  it('observes the commit-to-publish latency once per published row in {outbox,topic}', async () => {
    const { kafka, outbox } = setup();
    await seed(outbox, 3); // created at START + 1, + 2, + 3 ms
    vi.setSystemTime(START + 2_003);
    const relay = new OutboxRelay(FX_OUTBOX, outbox, kafka, lock, config(), { systemPool: true });

    await relay.tick(new AbortController().signal);

    const labels = { outbox: 'fx', topic: TOPIC };
    const count = `${OUTBOX_PUBLISH_LATENCY_SECONDS}_count`;
    const sum = `${OUTBOX_PUBLISH_LATENCY_SECONDS}_sum`;
    expect(await value(OUTBOX_PUBLISH_LATENCY_SECONDS, labels, count)).toBe(3);
    // 2.002 + 2.001 + 2.000 seconds.
    expect(await value(OUTBOX_PUBLISH_LATENCY_SECONDS, labels, sum)).toBeCloseTo(6.003, 3);
    expect(await value(OUTBOX_PUBLISHED_TOTAL, { ...labels, outcome: 'ok' })).toBe(3);
    expect(await value(OUTBOX_PUBLISHED_TOTAL, { ...labels, outcome: 'error' })).toBeUndefined();
  });

  it('counts outcome="error" for the failed row only', async () => {
    const { kafka, outbox } = setup();
    await seed(outbox, 5);
    const send = kafka.publishStored.bind(kafka);
    let calls = 0;
    vi.spyOn(kafka, 'publishStored').mockImplementation(
      async (topic: string, envelope: EventEnvelope<unknown>, key: string | null) => {
        calls += 1;
        if (calls === 3) throw new Error('broker unavailable');
        await send(topic, envelope, key);
      },
    );
    const relay = new OutboxRelay(FX_OUTBOX, outbox, kafka, lock, config(), { systemPool: true });

    await expect(relay.tick(new AbortController().signal)).resolves.toMatchObject({
      published: 2,
      failed: true,
    });

    const labels = { outbox: 'fx', topic: TOPIC };
    expect(await value(OUTBOX_PUBLISHED_TOTAL, { ...labels, outcome: 'ok' })).toBe(2);
    expect(await value(OUTBOX_PUBLISHED_TOTAL, { ...labels, outcome: 'error' })).toBe(1);
    expect(
      await value(
        OUTBOX_PUBLISH_LATENCY_SECONDS,
        labels,
        `${OUTBOX_PUBLISH_LATENCY_SECONDS}_count`,
      ),
    ).toBe(2);
  });

  it('reads leader 1 inside a term and 0 after it, and drops backlog and age then', async () => {
    const { kafka, outbox } = setup();
    await seed(outbox, 2);
    const relay = new OutboxRelay(FX_OUTBOX, outbox, kafka, lock, config(), { systemPool: true });
    const tick = vi.spyOn(relay, 'tick');

    const term = relay.runTerm(new AbortController().signal);
    await vi.waitFor(() => expect(tick).toHaveBeenCalled());
    await tick.mock.results[0]?.value;

    expect(await value(OUTBOX_RELAY_LEADER, { outbox: 'fx' })).toBe(1);
    expect(await value(OUTBOX_BACKLOG, { outbox: 'fx' })).toBe(2);
    expect(await value(OUTBOX_OLDEST_UNPUBLISHED_AGE_SECONDS, { outbox: 'fx' })).toBeDefined();

    lock.lose();
    await expect(term).resolves.toBe('lost');

    expect(await value(OUTBOX_RELAY_LEADER, { outbox: 'fx' })).toBe(0);
    expect(await value(OUTBOX_BACKLOG, { outbox: 'fx' })).toBeUndefined();
    expect(await value(OUTBOX_OLDEST_UNPUBLISHED_AGE_SECONDS, { outbox: 'fx' })).toBeUndefined();
    const scrape = await register.metrics();
    expect(scrape).not.toMatch(/^outbox_backlog\{outbox="fx"\}/m);
    expect(scrape).not.toMatch(/^outbox_oldest_unpublished_age_seconds\{outbox="fx"\}/m);
    expect(scrape).toMatch(/^outbox_relay_leader\{outbox="fx"\} 0$/m);
  });

  it('keeps two features apart by label value', async () => {
    const fy: OutboxFeature = { name: 'fy', table: fxOutbox };
    const first = setup(FX_OUTBOX);
    const second = setup(fy);
    await seed(first.outbox, 4);
    await seed(second.outbox, 1);
    const relayX = new OutboxRelay(FX_OUTBOX, first.outbox, first.kafka, lock, config(), {
      systemPool: true,
    });
    const relayY = new OutboxRelay(fy, second.outbox, second.kafka, lock, config(), {
      systemPool: true,
    });

    await relayX.tick(new AbortController().signal);
    await relayY.tick(new AbortController().signal);

    expect(await value(OUTBOX_BACKLOG, { outbox: 'fx' })).toBe(4);
    expect(await value(OUTBOX_BACKLOG, { outbox: 'fy' })).toBe(1);
    expect(await value(OUTBOX_PUBLISHED_TOTAL, { outbox: 'fx', topic: TOPIC, outcome: 'ok' })).toBe(
      4,
    );
    expect(await value(OUTBOX_PUBLISHED_TOTAL, { outbox: 'fy', topic: TOPIC, outcome: 'ok' })).toBe(
      1,
    );
  });
});

import { kafkaConfig } from '@app/config';
import { Logger } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';
import type { Admin } from 'kafkajs';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { KafkaHealthIndicator } from './kafka.health.js';

interface FakeAdmin {
  connect: ReturnType<typeof vi.fn<() => Promise<void>>>;
  disconnect: ReturnType<typeof vi.fn<() => Promise<void>>>;
  describeCluster: ReturnType<
    typeof vi.fn<
      () => Promise<{ brokers: unknown[]; controller: number | null; clusterId: string }>
    >
  >;
}

const fakeAdmin = (): FakeAdmin => ({
  connect: vi.fn(() => Promise.resolve()),
  disconnect: vi.fn(() => Promise.resolve()),
  describeCluster: vi.fn(() =>
    Promise.resolve({ brokers: [{}, {}, {}], controller: 1, clusterId: 'c1' }),
  ),
});

/** Test seam: hands out fake admin clients instead of connecting to a broker. */
class TestKafkaHealthIndicator extends KafkaHealthIndicator {
  readonly admins: FakeAdmin[] = [];
  next: () => FakeAdmin = fakeAdmin;

  protected override createAdmin(): Admin {
    const admin = this.next();
    this.admins.push(admin);
    return admin as unknown as Admin;
  }
}

const newIndicator = (): TestKafkaHealthIndicator =>
  new TestKafkaHealthIndicator(kafkaConfig.parse({}), new HealthIndicatorService());

describe('KafkaHealthIndicator', () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports up with the broker count and reuses one connected admin client', async () => {
    const indicator = newIndicator();
    await expect(indicator.check()).resolves.toMatchObject({
      kafka: { status: 'up', brokers: 3, controller: 1 },
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 10_000); // past the result cache
    await indicator.check();
    expect(indicator.admins).toHaveLength(1);
    expect(indicator.admins[0]?.connect).toHaveBeenCalledTimes(1);
    expect(indicator.admins[0]?.describeCluster).toHaveBeenCalledTimes(2);
  });

  it('reports down and rebuilds the admin client on the next check', async () => {
    const indicator = newIndicator();
    indicator.next = () => {
      const admin = fakeAdmin();
      admin.describeCluster.mockRejectedValue(new Error('Connection error: ECONNREFUSED'));
      return admin;
    };
    await expect(indicator.check()).resolves.toMatchObject({
      kafka: { status: 'down', message: 'Connection error: ECONNREFUSED' },
    });
    await vi.waitFor(() => expect(indicator.admins[0]?.disconnect).toHaveBeenCalled());

    indicator.next = fakeAdmin;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 10_000);
    await expect(indicator.check()).resolves.toMatchObject({ kafka: { status: 'up' } });
    expect(indicator.admins).toHaveLength(2);
  });

  it('reports down when the admin cannot connect', async () => {
    const indicator = newIndicator();
    indicator.next = () => {
      const admin = fakeAdmin();
      admin.connect.mockRejectedValue(new Error('broker unreachable'));
      return admin;
    };
    await expect(indicator.check()).resolves.toMatchObject({
      kafka: { status: 'down', message: 'broker unreachable' },
    });
  });

  it('disconnects on shutdown, and tolerates never having connected', async () => {
    const idle = newIndicator();
    await expect(idle.onApplicationShutdown()).resolves.toBeUndefined();

    const indicator = newIndicator();
    await indicator.check();
    await indicator.onApplicationShutdown();
    expect(indicator.admins[0]?.disconnect).toHaveBeenCalledTimes(1);
  });

  it('real kafkajs client: an unreachable broker is down at once and never stalls shutdown', async () => {
    // Port 1 refuses connections immediately. With kafkajs' default cluster retrier the connect
    // kept retrying for tens of seconds after the check timed out, and onApplicationShutdown
    // awaited it — SIGTERM during a Kafka outage hung until the hard-kill timer.
    const indicator = new KafkaHealthIndicator(
      kafkaConfig.parse({ KAFKA_BROKERS: '127.0.0.1:1', KAFKA_CONNECTION_TIMEOUT_MS: '500' }),
      new HealthIndicatorService(),
    );
    const startedAt = performance.now();
    await expect(indicator.check()).resolves.toMatchObject({ kafka: { status: 'down' } });
    expect(performance.now() - startedAt).toBeLessThan(2_000); // not the 2.5 s check timeout
    const shutdownAt = performance.now();
    await indicator.onApplicationShutdown();
    expect(performance.now() - shutdownAt).toBeLessThan(2_500);
  });

  it('has the readiness key "kafka"', () => {
    expect(newIndicator().key).toBe('kafka');
  });
});

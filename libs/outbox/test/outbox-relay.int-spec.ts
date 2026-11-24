import { type INestApplicationContext, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { TransactionHost } from '@nestjs-cls/transactional';
import { createPrincipal, generateId, runWithPrincipal } from '@platform/common';
import { AppConfigModule, type OutboxConfig } from '@platform/config';
import type { EventEnvelope } from '@platform/contracts';
import {
  DatabaseModule,
  type DrizzleTransactionHost,
  inUnitOfWork,
  platformMigrations,
  runMigrations,
} from '@platform/database';
import { DistributedLockService, type LockResult, RedisModule } from '@platform/redis';
import { type RlsTestPostgres, startRlsTestPostgres } from '@platform/testing/postgres';
import { FakeKafkaProducer } from '@platform/transport/testing';
import { noop } from 'lodash-es';
import { ClsModule } from 'nestjs-cls';
import postgres, { type Sql } from 'postgres';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  OutboxRelay,
  type OutboxRelayLock,
  type OutboxRelayPublisher,
} from '../src/outbox-relay.js';
import { OutboxWriter } from '../src/outbox-writer.js';
import {
  FX_OUTBOX,
  FX_OUTBOX_DDL,
  FxOutboxSystemRepository,
  fxSchema,
  ORDER_PLACED_EVENT,
  orderPlaced,
} from './outbox-fixture.js';

/*
 * Two relays on one outbox, on citusdata/citus:14.2.0 (startRlsTestPostgres: three roles, local
 * execution off) and a real Redis: a throwaway redis container, or INTEGRATION_REDIS_URL (never the
 * developer's default localhost:6379). Kafka is a FakeKafkaProducer per relay. Opt-in (needs Docker):
 *   INTEGRATION=1 bunx vitest run --project outbox:int
 */

const REDIS_IMAGE = 'redis:8.10.3-alpine3.23';
const TENANTS = [
  '0197a000-0000-7000-8000-0000000000a1',
  '0197a000-0000-7000-8000-0000000000b2',
  '0197a000-0000-7000-8000-0000000000c3',
  '0197a000-0000-7000-8000-0000000000d4',
  '0197a000-0000-7000-8000-0000000000e5',
] as const;
const ROWS = 200;
const RELAY: OutboxConfig = {
  relayEnabled: true,
  pollIntervalMs: 100,
  batchSize: 20,
  lockTtlMs: 1_000,
  maxBackoffMs: 1_000,
  retentionHours: 168,
};
const silent = { log: noop, warn: noop, error: noop, debug: noop };
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

class FxOutbox extends OutboxWriter {}

/** A relay instance with its own Kafka fake (each publish takes a few ms, like a broker ack). */
interface Instance {
  readonly name: string;
  readonly relay: OutboxRelay;
  readonly kafka: FakeKafkaProducer;
}

describe.skipIf(process.env['INTEGRATION'] !== '1')(
  'OutboxRelay on Citus 14.2 and Redis (two instances, one outbox)',
  () => {
    let pg: RlsTestPostgres;
    let redisContainer: StartedTestContainer | undefined;
    let admin: Sql;
    let app: INestApplicationContext;
    let txHost: DrizzleTransactionHost;
    let repository: FxOutboxSystemRepository;
    let locks: DistributedLockService;

    beforeAll(async () => {
      let redisUrl = process.env['INTEGRATION_REDIS_URL'];
      const [started] = await Promise.all([
        startRlsTestPostgres(),
        (async () => {
          if (redisUrl !== undefined) return;
          redisContainer = await new GenericContainer(REDIS_IMAGE)
            .withExposedPorts(6379)
            .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
            .start();
          redisUrl = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;
        })(),
      ]);
      pg = started;
      await runMigrations(pg.migrationUrl, { migrations: [platformMigrations], logger: silent });
      admin = postgres(pg.url, { max: 1, onnotice: noop });
      const owner = postgres(pg.migrationUrl, { max: 1, onnotice: noop });
      try {
        // One autocommit statement each (local execution off: shards are built over new connections).
        for (const statement of FX_OUTBOX_DDL) await owner.unsafe(statement);
      } finally {
        await owner.end({ timeout: 5 });
      }

      vi.stubEnv('DATABASE_URL', pg.runtimeUrl);
      vi.stubEnv('DATABASE_SYSTEM_URL', pg.systemUrl);
      vi.stubEnv('DATABASE_SYSTEM_POOL_MAX', '4');
      vi.stubEnv('DATABASE_POOL_MAX', '4');
      vi.stubEnv('DATABASE_RUN_MIGRATIONS', 'false');
      vi.stubEnv('REDIS_URL', redisUrl ?? '');
      vi.stubEnv('REDIS_KEY_PREFIX', `it-${generateId()}`);
      vi.stubEnv('SERVICE_NAME', 'outbox-relay-int');

      @Module({
        imports: [
          AppConfigModule.forRoot(),
          ClsModule.forRoot({ global: true }),
          DatabaseModule.forRootAsync({ schema: fxSchema, migrations: [], runMigrations: false }),
          RedisModule.forRootAsync(),
        ],
        providers: [FxOutboxSystemRepository],
      })
      class OutboxRelayIntegrationModule {}

      app = await NestFactory.createApplicationContext(OutboxRelayIntegrationModule, {
        logger: false,
        abortOnError: false,
      });
      txHost = app.get(TransactionHost);
      repository = app.get(FxOutboxSystemRepository);
      locks = app.get(DistributedLockService);
    });

    afterAll(async () => {
      await app?.close();
      await admin?.end({ timeout: 5 });
      await pg?.stop();
      await redisContainer?.stop();
      vi.unstubAllEnvs();
    });

    it('publishes every row at least once with one leader at a time, and fails over on stop', async () => {
      // 200 rows over five tenants, written by the runtime role (one unit of work per tenant).
      const writer = new FxOutbox(
        FX_OUTBOX,
        txHost,
        new FakeKafkaProducer({ source: 'fx-service' }),
      );
      const rowIds: string[] = [];
      for (const tenantId of TENANTS) {
        const principal = createPrincipal({ userId: generateId(), tenantId, roles: ['member'] });
        const ids = await runWithPrincipal(principal, () =>
          inUnitOfWork(txHost, async () => {
            const enqueued: string[] = [];
            for (let row = 0; row < ROWS / TENANTS.length; row += 1) {
              const envelope = await writer.enqueue(ORDER_PLACED_EVENT, orderPlaced());
              enqueued.push(envelope.id);
            }
            return enqueued;
          }),
        );
        expect(ids).toHaveLength(ROWS / TENANTS.length);
        rowIds.push(...ids);
      }
      const [{ count: stored } = { count: 0 }] = await admin<{ count: number }[]>`
        select count(*)::int as count from fx.outbox where published_at is null`;
      expect(stored).toBe(ROWS);

      // A shared counter of the instances inside a term, through the real lock.
      let inTerm = 0;
      let maxInTerm = 0;
      let holder = null as string | null;
      const termStarts: { name: string; at: number }[] = [];
      const lockFor = (name: string): OutboxRelayLock => ({
        using: <T>(
          resource: string,
          ttlMs: number,
          fn: (signal: AbortSignal) => Promise<T>,
        ): Promise<LockResult<T>> =>
          locks.using(resource, ttlMs, async (signal) => {
            inTerm += 1;
            maxInTerm = Math.max(maxInTerm, inTerm);
            holder = name;
            termStarts.push({ name, at: Date.now() });
            try {
              return await fn(signal);
            } finally {
              holder = null;
              inTerm -= 1;
            }
          }),
      });
      const instance = (name: string): Instance => {
        const kafka = new FakeKafkaProducer({ source: 'fx-service' });
        const publisher: OutboxRelayPublisher = {
          publishStored: async (
            topic: string,
            envelope: EventEnvelope<unknown>,
            key: string | null,
          ) => {
            await sleep(5);
            await kafka.publishStored(topic, envelope, key);
          },
        };
        const relay = new OutboxRelay(FX_OUTBOX, repository, publisher, lockFor(name), RELAY, {
          systemPool: true,
        });
        return { name, relay, kafka };
      };
      const instances = [instance('one'), instance('two')];
      const publishedIds = (): string[] =>
        instances.flatMap(({ kafka }) => kafka.records.map((record) => record.value.id));

      try {
        for (const { relay } of instances) relay.onApplicationBootstrap();

        // Stop the leader mid-run: the follower takes over within lockTtlMs + 2 × pollIntervalMs.
        await vi.waitFor(() => expect(publishedIds().length).toBeGreaterThanOrEqual(40), {
          timeout: 30_000,
          interval: 5,
        });
        const leaderName = holder;
        expect(leaderName).not.toBeNull();
        const leader = instances.find(({ name }) => name === leaderName);
        const follower = instances.find(({ name }) => name !== leaderName);
        if (leader === undefined || follower === undefined) throw new Error('no leader');
        expect(publishedIds().length).toBeLessThan(ROWS);
        const stoppedAt = Date.now();
        await leader.relay.beforeApplicationShutdown();
        await vi.waitFor(
          () =>
            expect(
              termStarts.some(({ name, at }) => name === follower.name && at >= stoppedAt),
            ).toBe(true),
          { timeout: 10_000, interval: 5 },
        );
        const takeover = termStarts.find(
          ({ name, at }) => name === follower.name && at >= stoppedAt,
        );
        expect((takeover?.at ?? Number.POSITIVE_INFINITY) - stoppedAt).toBeLessThanOrEqual(
          RELAY.lockTtlMs + 2 * RELAY.pollIntervalMs,
        );

        // Every row ends published; the published ids are exactly the row ids (duplicates allowed).
        await vi.waitFor(
          async () => {
            const [{ count } = { count: -1 }] = await admin<{ count: number }[]>`
              select count(*)::int as count from fx.outbox where published_at is null`;
            expect(count).toBe(0);
          },
          { timeout: 30_000, interval: 50 },
        );
        expect(follower.kafka.records.length).toBeGreaterThan(0);
        expect(new Set(publishedIds())).toEqual(new Set(rowIds));
        const rows = await admin<{ id: string; published_at: Date | null }[]>`
          select id, published_at from fx.outbox`;
        expect(rows).toHaveLength(ROWS);
        expect(rows.every((row) => row.published_at !== null)).toBe(true);
        expect(maxInTerm).toBe(1);
      } finally {
        for (const { relay } of instances) await relay.beforeApplicationShutdown();
      }
    });
  },
);

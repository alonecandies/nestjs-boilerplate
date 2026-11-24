import { createServer } from 'node:net';
import { type INestApplicationContext, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { TransactionHost } from '@nestjs-cls/transactional';
import {
  createPrincipal,
  ExternalServiceException,
  generateId,
  runWithPrincipal,
} from '@platform/common';
import { AppConfigModule, type OutboxConfig } from '@platform/config';
import type { EventEnvelope } from '@platform/contracts';
import {
  DatabaseModule,
  type DrizzleTransactionHost,
  inUnitOfWork,
  platformMigrations,
  runMigrations,
} from '@platform/database';
import { type RlsTestPostgres, startRlsTestPostgres } from '@platform/testing/postgres';
import { KAFKA_ERROR_CODES, KafkaProducer, KafkaProducerModule } from '@platform/transport';
import { Kafka, logLevel } from 'kafkajs';
import { noop } from 'lodash-es';
import { ClsModule } from 'nestjs-cls';
import postgres, { type Sql } from 'postgres';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  OutboxRelay,
  type OutboxRelayLock,
  type OutboxRelayPublisher,
  type OutboxRelayRepository,
} from '../src/outbox-relay.js';
import { OutboxWriter } from '../src/outbox-writer.js';
import {
  FX_OUTBOX,
  FX_OUTBOX_DDL,
  FxOutboxSystemRepository,
  fxSchema,
  ORDER_PLACED_EVENT,
  type OrderPlacedPayload,
  orderPlaced,
} from './outbox-fixture.js';

/*
 * The outbox's at-least-once delivery against a real broker (inventory FU-6): the real
 * `KafkaProducerModule` (ClientKafka, idempotent producer, acks -1) publishes what the relay polls
 * from a real Citus outbox table, and a plain kafkajs consumer reads the topic back. Opt-in
 * (needs Docker; the Kafka image is the one of docker-compose.yml):
 *   INTEGRATION=1 bunx vitest run --project outbox:int outbox-kafka-delivery
 *
 * The relay is driven tick by tick (`OutboxRelay.tick`), so each step is deterministic; the leader
 * lock and the loop are covered by outbox-relay.int-spec.ts. The publish failure is injected in
 * front of the real producer (nothing reaches the broker, as when the broker refuses a record);
 * the duplicate is the real thing: the record IS acknowledged by the broker, then the mark fails.
 */

const KAFKA_IMAGE = 'apache/kafka:4.3.1';
const TOPIC = ORDER_PLACED_EVENT.topic;
const TENANT = '0197a000-0000-7000-8000-0000000000a1';
const RELAY: OutboxConfig = {
  relayEnabled: true,
  pollIntervalMs: 100,
  batchSize: 20,
  lockTtlMs: 1_000,
  maxBackoffMs: 1_000,
  retentionHours: 168,
};
const silent = { log: noop, warn: noop, error: noop, debug: noop };

class FxOutbox extends OutboxWriter {}

/** What the consumer saw of one delivered record. */
interface Delivery {
  readonly key: string | null;
  readonly eventType: string | undefined;
  readonly envelope: EventEnvelope<OrderPlacedPayload>;
}

async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === 'string') throw new Error('no free port');
  return address.port;
}

/** A single-node KRaft broker whose advertised external address is the mapped host port. */
async function startKafka(): Promise<{ container: StartedTestContainer; broker: string }> {
  const port = await freeLoopbackPort();
  const broker = `127.0.0.1:${port}`;
  const container = await new GenericContainer(KAFKA_IMAGE)
    .withExposedPorts({ container: 9094, host: port })
    .withEnvironment({
      CLUSTER_ID: '5L6g3nShT-eMCtK--X86sw',
      KAFKA_NODE_ID: '1',
      KAFKA_PROCESS_ROLES: 'broker,controller',
      KAFKA_LISTENERS: 'PLAINTEXT://:9092,CONTROLLER://:9093,EXTERNAL://:9094',
      KAFKA_ADVERTISED_LISTENERS: `PLAINTEXT://127.0.0.1:9092,EXTERNAL://${broker}`,
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP:
        'CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT,EXTERNAL:PLAINTEXT',
      KAFKA_CONTROLLER_LISTENER_NAMES: 'CONTROLLER',
      KAFKA_CONTROLLER_QUORUM_VOTERS: '1@127.0.0.1:9093',
      KAFKA_INTER_BROKER_LISTENER_NAME: 'PLAINTEXT',
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: '1',
      KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: '1',
      KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: '1',
      KAFKA_DEFAULT_REPLICATION_FACTOR: '1',
      KAFKA_NUM_PARTITIONS: '1',
      KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: '0',
    })
    .withWaitStrategy(Wait.forLogMessage(/Kafka Server started/))
    .withStartupTimeout(180_000)
    .start();
  return { container, broker };
}

describe.skipIf(process.env['INTEGRATION'] !== '1')(
  'Outbox delivery to a real Kafka broker (at least once)',
  () => {
    let pg: RlsTestPostgres;
    let kafkaContainer: StartedTestContainer | undefined;
    let admin: Sql;
    let app: INestApplicationContext;
    let txHost: DrizzleTransactionHost;
    let repository: FxOutboxSystemRepository;
    let producer: KafkaProducer;
    let writer: FxOutbox;
    let kafkaAdmin: ReturnType<Kafka['admin']>;
    let consumer: ReturnType<Kafka['consumer']>;

    /** Every record the consumer received, in arrival order (a redelivery shows up twice). */
    const deliveries: Delivery[] = [];
    /** The consumer's idempotent effect: one entry per envelope id, whatever the delivery count. */
    const effects = new Map<string, EventEnvelope<OrderPlacedPayload>>();
    /** Per partition, the offset after the last record the consumer handled. */
    const consumedTo = new Map<number, number>();

    const deliveriesOf = (id: string): Delivery[] =>
      deliveries.filter(({ envelope }) => envelope.id === id);

    /** Total records on the topic, from the broker's high watermarks. */
    const topicRecordCount = async (): Promise<number> => {
      const offsets = await kafkaAdmin.fetchTopicOffsets(TOPIC);
      return offsets.reduce((sum, { high, low }) => sum + (Number(high) - Number(low)), 0);
    };

    /**
     * Waits until the consumer has handled every record the broker holds now (up to each
     * partition's high watermark): whatever was on the topic has been seen by then.
     */
    const consumedToHighWatermark = async (): Promise<void> => {
      const offsets = await kafkaAdmin.fetchTopicOffsets(TOPIC);
      await vi.waitFor(
        () => {
          for (const { partition, high } of offsets) {
            expect(consumedTo.get(partition) ?? 0).toBeGreaterThanOrEqual(Number(high));
          }
        },
        { timeout: 30_000, interval: 50 },
      );
    };

    const unpublishedCount = async (): Promise<number> => {
      const [{ count } = { count: -1 }] = await admin<{ count: number }[]>`
        select count(*)::int as count from fx.outbox where published_at is null`;
      return count;
    };

    const isPublished = async (id: string): Promise<boolean> => {
      const rows = await admin<{ published_at: Date | null }[]>`
        select published_at from fx.outbox where id = ${id}`;
      return rows[0]?.published_at != null;
    };

    /** One committed unit of work of the tenant that enqueues `count` orders. */
    const enqueueCommitted = (count: number): Promise<EventEnvelope<OrderPlacedPayload>[]> =>
      runWithPrincipal(
        createPrincipal({ userId: generateId(), tenantId: TENANT, roles: ['member'] }),
        () =>
          inUnitOfWork(txHost, async () => {
            const envelopes: EventEnvelope<OrderPlacedPayload>[] = [];
            for (let row = 0; row < count; row += 1) {
              const payload = orderPlaced();
              envelopes.push(
                await writer.enqueue(ORDER_PLACED_EVENT, payload, { key: payload.orderId }),
              );
            }
            return envelopes;
          }),
      );

    // The faults in front of the real producer and the real repository; each is armed per test.
    let failPublishes = 0;
    let failMarks = 0;

    const publisher: OutboxRelayPublisher = {
      publishStored: async (topic, envelope, key) => {
        if (failPublishes > 0) {
          failPublishes -= 1;
          throw new ExternalServiceException(`Failed to publish "${topic}" event`, {
            code: KAFKA_ERROR_CODES.PUBLISH_FAILED,
            details: { topic, eventId: envelope.id },
          });
        }
        await producer.publishStored(topic, envelope, key);
      },
    };
    const faultyRepository: OutboxRelayRepository = {
      pollUnpublished: (limit) => repository.pollUnpublished(limit),
      markPublished: (rows) => {
        if (failMarks > 0) {
          failMarks -= 1;
          return Promise.reject(new Error('the mark failed after the broker acknowledged'));
        }
        return repository.markPublished(rows);
      },
      deletePublishedBefore: (cutoff) => repository.deletePublishedBefore(cutoff),
    };
    // `tick` never takes the lock; the lock and the loop are covered by outbox-relay.int-spec.ts.
    const noLock: OutboxRelayLock = {
      using: () => Promise.reject(new Error('the lock is not used by tick()')),
    };

    const tick = () => {
      const relay = new OutboxRelay(FX_OUTBOX, faultyRepository, publisher, noLock, RELAY, {
        systemPool: true,
      });
      return relay.tick(new AbortController().signal);
    };

    beforeAll(async () => {
      const [started, kafka] = await Promise.all([startRlsTestPostgres(), startKafka()]);
      pg = started;
      kafkaContainer = kafka.container;
      await runMigrations(pg.migrationUrl, { migrations: [platformMigrations], logger: silent });
      admin = postgres(pg.url, { max: 1, onnotice: noop });
      const owner = postgres(pg.migrationUrl, { max: 1, onnotice: noop });
      try {
        // One autocommit statement each (local execution off: shards are built over new connections).
        for (const statement of FX_OUTBOX_DDL) await owner.unsafe(statement);
      } finally {
        await owner.end({ timeout: 5 });
      }

      // The topic exists before anything publishes (the producer never auto-creates topics).
      const client = new Kafka({
        clientId: 'outbox-kafka-delivery-int',
        brokers: [kafka.broker],
        logLevel: logLevel.NOTHING,
      });
      kafkaAdmin = client.admin();
      await kafkaAdmin.connect();
      await kafkaAdmin.createTopics({
        waitForLeaders: true,
        topics: [{ topic: TOPIC, numPartitions: 1, replicationFactor: 1 }],
      });

      // An idempotent consumer, as every handler of this repo is: it dedupes on the envelope id.
      consumer = client.consumer({ groupId: `outbox-kafka-delivery-${generateId()}` });
      await consumer.connect();
      await consumer.subscribe({ topic: TOPIC, fromBeginning: true });
      await consumer.run({
        eachMessage: async ({ partition, message }) => {
          const envelope = JSON.parse(
            message.value?.toString('utf8') ?? 'null',
          ) as EventEnvelope<OrderPlacedPayload>;
          deliveries.push({
            key: message.key?.toString('utf8') ?? null,
            eventType: message.headers?.['x-event-type']?.toString(),
            envelope,
          });
          if (!effects.has(envelope.id)) effects.set(envelope.id, envelope);
          consumedTo.set(partition, Number(message.offset) + 1);
        },
      });

      vi.stubEnv('DATABASE_URL', pg.runtimeUrl);
      vi.stubEnv('DATABASE_SYSTEM_URL', pg.systemUrl);
      vi.stubEnv('DATABASE_SYSTEM_POOL_MAX', '4');
      vi.stubEnv('DATABASE_POOL_MAX', '4');
      vi.stubEnv('DATABASE_RUN_MIGRATIONS', 'false');
      vi.stubEnv('KAFKA_BROKERS', kafka.broker);
      vi.stubEnv('SERVICE_NAME', 'outbox-kafka-delivery-int');

      @Module({
        imports: [
          AppConfigModule.forRoot(),
          ClsModule.forRoot({ global: true }),
          DatabaseModule.forRootAsync({ schema: fxSchema, migrations: [], runMigrations: false }),
          KafkaProducerModule.forRootAsync({ source: 'fx-service', eagerConnect: false }),
        ],
        providers: [FxOutboxSystemRepository],
      })
      class OutboxKafkaDeliveryIntegrationModule {}

      app = await NestFactory.createApplicationContext(OutboxKafkaDeliveryIntegrationModule, {
        logger: false,
        abortOnError: false,
      });
      txHost = app.get(TransactionHost);
      repository = app.get(FxOutboxSystemRepository);
      producer = app.get(KafkaProducer);
      expect(await producer.connect()).toBe(true);
      writer = new FxOutbox(FX_OUTBOX, txHost, producer);
    });

    afterAll(async () => {
      await consumer?.disconnect();
      await kafkaAdmin?.disconnect();
      await app?.close();
      await admin?.end({ timeout: 5 });
      await pg?.stop();
      await kafkaContainer?.stop();
      vi.unstubAllEnvs();
    });

    it('delivers a row enqueued in a committed transaction to a real consumer, never a rolled-back one', async () => {
      const principal = createPrincipal({
        userId: generateId(),
        tenantId: TENANT,
        roles: ['member'],
      });
      const discarded = await runWithPrincipal(principal, async () => {
        let envelopeId: string | undefined;
        await expect(
          inUnitOfWork(txHost, async () => {
            const payload = orderPlaced();
            envelopeId = (await writer.enqueue(ORDER_PLACED_EVENT, payload)).id;
            throw new Error('the business transaction fails after the enqueue');
          }),
        ).rejects.toThrow('business transaction fails');
        return envelopeId;
      });
      const committed = await enqueueCommitted(3);

      // Only the committed rows exist; the relay has not run, so the broker has nothing yet.
      expect(await unpublishedCount()).toBe(3);
      expect(await topicRecordCount()).toBe(0);

      const result = await tick();
      expect(result).toEqual({ polled: 3, published: 3, failed: false });

      await vi.waitFor(() => expect(committed.every(({ id }) => effects.has(id))).toBe(true), {
        timeout: 30_000,
        interval: 50,
      });
      for (const envelope of committed) {
        const [delivery] = deliveriesOf(envelope.id);
        expect(deliveriesOf(envelope.id)).toHaveLength(1);
        expect(delivery?.envelope).toEqual(JSON.parse(JSON.stringify(envelope)));
        expect(delivery?.eventType).toBe(TOPIC);
        expect(delivery?.key).toBe(envelope.payload.orderId);
        expect(delivery?.envelope.tenantId).toBe(TENANT);
        expect(await isPublished(envelope.id)).toBe(true);
      }
      expect(await unpublishedCount()).toBe(0);
      expect(await topicRecordCount()).toBe(3);
      expect(discarded).toBeDefined();
      expect(effects.has(discarded ?? '')).toBe(false);
    });

    it('keeps the row unpublished when the publish fails and delivers it on a later tick', async () => {
      const [envelope] = await enqueueCommitted(1);
      if (envelope === undefined) throw new Error('nothing enqueued');
      const before = await topicRecordCount();

      failPublishes = 1;
      const failed = await tick();
      expect(failed).toEqual({ polled: 1, published: 0, failed: true });
      expect(await isPublished(envelope.id)).toBe(false);
      expect(await unpublishedCount()).toBe(1);
      // The broker holds nothing new, and the consumer has read all it holds: nothing was delivered.
      expect(await topicRecordCount()).toBe(before);
      await consumedToHighWatermark();
      expect(deliveriesOf(envelope.id)).toHaveLength(0);

      const retried = await tick();
      expect(retried).toEqual({ polled: 1, published: 1, failed: false });
      await vi.waitFor(() => expect(effects.has(envelope.id)).toBe(true), {
        timeout: 30_000,
        interval: 50,
      });
      expect(deliveriesOf(envelope.id)).toHaveLength(1);
      expect(await isPublished(envelope.id)).toBe(true);
      expect(await topicRecordCount()).toBe(before + 1);
    });

    it('delivers twice when the mark fails after the broker ack, and the consumer applies it once', async () => {
      const [envelope] = await enqueueCommitted(1);
      if (envelope === undefined) throw new Error('nothing enqueued');

      failMarks = 1;
      const first = await tick();
      expect(first).toEqual({ polled: 1, published: 1, failed: true });
      // The broker has the record, the outbox does not know: the row stays unpublished.
      expect(await isPublished(envelope.id)).toBe(false);

      const second = await tick();
      expect(second).toEqual({ polled: 1, published: 1, failed: false });
      expect(await isPublished(envelope.id)).toBe(true);

      await vi.waitFor(() => expect(deliveriesOf(envelope.id)).toHaveLength(2), {
        timeout: 30_000,
        interval: 50,
      });
      const [one, two] = deliveriesOf(envelope.id);
      // The very same envelope both times (same id), so the consumer's dedupe key holds.
      expect(one?.envelope).toEqual(two?.envelope);
      expect(one?.envelope.id).toBe(envelope.id);
      // The idempotent consumer applied the effect once.
      expect([...effects.keys()].filter((id) => id === envelope.id)).toHaveLength(1);
      expect(effects.get(envelope.id)?.payload).toEqual(envelope.payload);
      expect(await unpublishedCount()).toBe(0);
    });
  },
);

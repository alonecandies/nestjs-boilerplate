import { type INestMicroservice, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { type CustomStrategy, Payload } from '@nestjs/microservices';
import { generateId } from '@platform/common';
import { kafkaConfig } from '@platform/config';
import { Kafka, logLevel } from 'kafkajs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { InstrumentedServerKafka } from '../src/kafka/instrumented-server-kafka.js';
import { DEAD_LETTER_SUFFIX } from '../src/kafka/kafka.constants.js';
import { createKafkaServerOptions } from '../src/kafka/kafka.options.js';
import { KafkaConsumerController } from '../src/kafka/kafka-consumer.decorator.js';
import { KafkaEventPattern } from '../src/kafka/kafka-event-pattern.decorator.js';
import type { KafkaConsumerLike } from '../src/kafka/kafka-metrics.js';
import { FIXTURE_USER_REGISTERED_EVENT } from './fixtures/fixture.events.js';
import { type StartedKafka, startKafka } from './support/kafka-container.js';

/*
 * The Nest consumer stack (`InstrumentedServerKafka`, `@KafkaConsumerController()`) on a real
 * broker, for what only a broker can show: the consumer session and its heartbeats. Opt-in (needs
 * Docker; the Kafka image is the one of docker-compose.yml):
 *   INTEGRATION=1 bunx vitest run --project transport:int
 *
 * The session is 10 s here (30 s in production) so the slow handler outlasts it in a short test.
 */

const TOPIC = FIXTURE_USER_REGISTERED_EVENT.topic;
const SESSION_TIMEOUT_MS = 10_000;
/** Longer than the session: without heartbeats while it runs, the member is evicted. */
const SLOW_HANDLER_MS = 15_000;

type Kind = 'slow' | 'marker';

/** What the consumer saw, in order: one entry per handler invocation (a redelivery shows twice). */
const invocations: { kind: Kind; startedAt: number; endedAt?: number }[] = [];
/** kafkajs instrumentation events of the consumer, with their times. */
const groupJoins: number[] = [];
const heartbeats: number[] = [];

const count = (kind: Kind): number => invocations.filter((entry) => entry.kind === kind).length;

@KafkaConsumerController()
class SessionConsumer {
  @KafkaEventPattern(FIXTURE_USER_REGISTERED_EVENT)
  async onRecord(@Payload() payload: { kind: Kind }): Promise<void> {
    const entry: (typeof invocations)[number] = { kind: payload.kind, startedAt: Date.now() };
    invocations.push(entry);
    // The workload itself, not a wait in the test: one message whose handling outlasts the session.
    if (payload.kind === 'slow') {
      await new Promise<void>((resolve) => setTimeout(resolve, SLOW_HANDLER_MS));
    }
    entry.endedAt = Date.now();
  }
}

@Module({ controllers: [SessionConsumer] })
class SessionConsumerModule {}

/** The production server, plus a record of the group joins and heartbeats of its consumer. */
class ObservedServerKafka extends InstrumentedServerKafka {
  override async bindEvents(consumer: KafkaConsumerLike): Promise<void> {
    consumer.on(consumer.events.GROUP_JOIN, () => groupJoins.push(Date.now()));
    consumer.on(consumer.events.HEARTBEAT, () => heartbeats.push(Date.now()));
    await super.bindEvents(consumer);
  }
}

describe.skipIf(process.env['INTEGRATION'] !== '1')(
  'A Nest Kafka consumer on a real broker: session and heartbeats',
  () => {
    let kafka: StartedKafka | undefined;
    let admin: ReturnType<Kafka['admin']> | undefined;
    let producer: ReturnType<Kafka['producer']> | undefined;
    let app: INestMicroservice | undefined;
    const groupId = `transport-session-${generateId()}`;

    const committedOffset = async (): Promise<string | undefined> => {
      const [topic] = await (admin as ReturnType<Kafka['admin']>).fetchOffsets({
        groupId,
        topics: [TOPIC],
      });
      return topic?.partitions.find(({ partition }) => partition === 0)?.offset;
    };

    beforeAll(async () => {
      kafka = await startKafka();
      const client = new Kafka({
        clientId: 'transport-session-int',
        brokers: [kafka.broker],
        logLevel: logLevel.NOTHING,
      });
      admin = client.admin();
      await admin.connect();
      // Auto-creation is off for consumers: the topic and its dead-letter topic exist first.
      await admin.createTopics({
        waitForLeaders: true,
        topics: [TOPIC, `${TOPIC}${DEAD_LETTER_SUFFIX}`].map((topic) => ({
          topic,
          numPartitions: 1,
          replicationFactor: 1,
        })),
      });
      producer = client.producer();
      await producer.connect();
    });

    afterAll(async () => {
      await app?.close();
      await producer?.disconnect();
      await admin?.disconnect();
      await kafka?.container.stop();
    });

    it('a handler that outlasts the session is invoked once and its offset is committed', async () => {
      // Both records first, on the one partition: the marker can only be handled after the slow
      // record's offset was resolved in the same generation, so a redelivery of the slow record
      // (an evicted member) would come before it.
      await producer?.send({
        topic: TOPIC,
        messages: (['slow', 'marker'] as const).map((kind) => ({
          key: 'session',
          value: JSON.stringify({ kind }),
        })),
      });

      const cfg = kafkaConfig.parse({
        SERVICE_NAME: 'transport-session-int',
        KAFKA_BROKERS: kafka?.broker,
      });
      const { options } = createKafkaServerOptions(cfg, { groupId });
      options.consumer = { ...options.consumer, groupId, sessionTimeout: SESSION_TIMEOUT_MS };
      // A new group otherwise starts at the latest offset, after the records produced above.
      options.subscribe = { fromBeginning: true };
      app = await NestFactory.createMicroservice<CustomStrategy>(SessionConsumerModule, {
        strategy: new ObservedServerKafka(options),
        logger: false,
      });
      await app.listen();

      // Ends on the marker (the fix) or on a second slow invocation (an evicted member).
      await vi.waitFor(() => expect(count('marker') + Math.max(0, count('slow') - 1)).toBe(1), {
        timeout: 90_000,
        interval: 250,
      });
      expect(invocations.map(({ kind }) => kind)).toEqual(['slow', 'marker']);

      // Both offsets are committed by the one generation that handled them.
      await vi.waitFor(async () => expect(await committedOffset()).toBe('2'), {
        timeout: 20_000,
        interval: 250,
      });
      expect(groupJoins).toHaveLength(1);

      // Heartbeats went out while the slow handler ran, never a session apart. kafkajs skips a
      // call made just under one interval after the last heartbeat, so about every 6 s here.
      const [slow] = invocations;
      const startedAt = slow?.startedAt ?? 0;
      const endedAt = slow?.endedAt ?? 0;
      expect(endedAt - startedAt).toBeGreaterThanOrEqual(SLOW_HANDLER_MS);
      const marks = [
        startedAt,
        ...heartbeats.filter((at) => at > startedAt && at < endedAt),
        endedAt,
      ];
      const gaps = marks.slice(1).map((at, index) => at - (marks[index] ?? at));
      expect(marks.length).toBeGreaterThan(2);
      expect(Math.max(...gaps)).toBeLessThan(SESSION_TIMEOUT_MS);
    });
  },
);

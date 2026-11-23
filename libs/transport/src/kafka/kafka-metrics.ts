import type { ServerKafka } from '@nestjs/microservices';
import { getOrCreateCounter, getOrCreateGauge } from '@platform/observability';

export const KAFKA_CONSUMER_MESSAGES_TOTAL = 'kafka_consumer_messages_total';
export const KAFKA_CONSUMER_RETRIES_TOTAL = 'kafka_consumer_retries_total';
export const KAFKA_CONSUMER_LAG = 'kafka_consumer_lag';

/** `success`: handled; `dead_letter`: sent to `<topic>.dlq`; `redelivery`: left to kafkajs. */
export type KafkaMessageOutcome = 'success' | 'dead_letter' | 'redelivery';

const KAFKA_MESSAGE_OUTCOMES: readonly KafkaMessageOutcome[] = [
  'success',
  'dead_letter',
  'redelivery',
];

/** The consumer Nest hands to `ServerKafka.bindEvents` (Nest's copy of the kafkajs typings). */
export type KafkaConsumerLike = Parameters<ServerKafka['bindEvents']>[0];

const messages = () =>
  getOrCreateCounter({
    name: KAFKA_CONSUMER_MESSAGES_TOTAL,
    help: 'Kafka messages consumed, by topic and outcome (success, dead_letter, redelivery)',
    labelNames: ['topic', 'outcome'],
  });

const retries = () =>
  getOrCreateCounter({
    name: KAFKA_CONSUMER_RETRIES_TOTAL,
    help: 'In-process retries of Kafka handlers (KafkaRetryInterceptor), by topic',
    labelNames: ['topic'],
  });

const lag = () =>
  getOrCreateGauge({
    name: KAFKA_CONSUMER_LAG,
    help: 'Kafka consumer lag in messages at the end of the last batch, by group, topic and partition',
    labelNames: ['group', 'topic', 'partition'],
  });

export function recordKafkaOutcome(topic: string, outcome: KafkaMessageOutcome): void {
  messages().inc({ topic, outcome });
}

/**
 * Creates the `{topic, outcome}` series of a subscribed topic at 0. A series that appears with its
 * first `inc()` starts at 1, so `increase(...[15m]) > 0` (`KafkaDeadLetters`) would read 0 for the
 * first dead letter; started at 0, that dead letter is an increase.
 */
export function initKafkaTopicMetrics(topic: string): void {
  for (const outcome of KAFKA_MESSAGE_OUTCOMES) messages().inc({ topic, outcome }, 0);
}

export function recordKafkaRetry(topic: string): void {
  retries().inc({ topic });
}

/** Feeds `kafka_consumer_lag` from kafkajs' `END_BATCH_PROCESS` instrumentation event. */
export function instrumentKafkaConsumer(consumer: KafkaConsumerLike, groupId: string): void {
  consumer.on(consumer.events.END_BATCH_PROCESS, (event) => {
    const { topic, partition, offsetLag } = event.payload;
    lag().set({ group: groupId, topic, partition: String(partition) }, Number(offsetLag));
  });
}

import type { KafkaConfig as KafkaNamespaceConfig } from '@app/config';
import { type KafkaOptions, Transport } from '@nestjs/microservices';
import { CompressionTypes, logLevel, Partitioners } from 'kafkajs';
import { createKafkaLogCreator } from './kafka-logger.js';

/**
 * Nest's copy of the kafkajs `KafkaConfig`. It is structurally compatible with kafkajs' own type,
 * so the same object also configures a plain `new Kafka()` (see `KafkaHealthIndicator`).
 */
export type KafkaClientConfig = NonNullable<NonNullable<KafkaOptions['options']>['client']>;

type SaslConfig = NonNullable<KafkaNamespaceConfig['sasl']>;

/** Narrows the config's mechanism union to kafkajs' discriminated SASL options. */
function toSaslOptions({
  mechanism,
  username,
  password,
}: SaslConfig): NonNullable<KafkaClientConfig['sasl']> {
  switch (mechanism) {
    case 'plain':
      return { mechanism, username, password };
    case 'scram-sha-256':
      return { mechanism, username, password };
    case 'scram-sha-512':
      return { mechanism, username, password };
  }
}

/**
 * kafkajs client config from the `kafka` namespace. There is deliberately NO `retry.retries` at
 * this level: kafkajs merges it into the idempotent producer's retry and then warns that limiting
 * retries may break exactly-once delivery (nest-distributed §9.12). Consumers set their own
 * `consumer.retry`.
 *
 * `logCreator` routes kafkajs logs through Nest's `Logger` (pino) and downgrades its retry and
 * reconnect noise to WARN (`createKafkaLogCreator`). Nest spreads `client` over its own default
 * `logCreator`, so this one wins for the consumer and producer clients too.
 */
export function createKafkaClientConfig(
  cfg: KafkaNamespaceConfig,
  clientId = cfg.clientId,
): KafkaClientConfig {
  return {
    clientId,
    brokers: [...cfg.brokers],
    ssl: cfg.ssl,
    ...(cfg.sasl === undefined ? {} : { sasl: toSaslOptions(cfg.sasl) }),
    connectionTimeout: cfg.connectionTimeoutMs,
    requestTimeout: cfg.requestTimeoutMs,
    logLevel: logLevel.WARN,
    logCreator: createKafkaLogCreator(),
    retry: { initialRetryTime: 300, maxRetryTime: 30_000 },
  };
}

/**
 * Producer settings shared by the producer-only client and the consumer's own producer (which
 * `KafkaDeadLetterFilter` uses):
 * - `idempotent` + `acks: -1`: no duplicates or reordering caused by producer retries. kafkajs
 *   refuses an idempotent producer without `acks: -1`.
 * - `DefaultPartitioner` explicitly: the same key always lands on the same partition (per-aggregate
 *   ordering), and kafkajs stops printing its v2 partitioner warning.
 * - GZIP is the only codec built into kafkajs; JSON envelopes compress well.
 */
const PRODUCER_OPTIONS = {
  producer: {
    createPartitioner: Partitioners.DefaultPartitioner,
    idempotent: true,
    maxInFlightRequests: 5,
    allowAutoTopicCreation: false,
  },
  send: { acks: -1, timeout: 30_000, compression: CompressionTypes.GZIP },
} as const satisfies Pick<NonNullable<KafkaOptions['options']>, 'producer' | 'send'>;

export interface KafkaServerOptionsExtras {
  /** Consumer group. Default `kafkaConfig.groupId` (`SERVICE_NAME`). */
  groupId?: string | undefined;
}

/**
 * Consumer (server) options for `connectKafkaConsumer` / `createMicroservice`:
 * - `postfixId: ''`: Nest otherwise appends `-server` to BOTH the client id and the group id, so two
 *   services configured with the same group would silently land in different groups (§9.11).
 * - `allowAutoTopicCreation: false`: topics (and their `.dlq`) are provisioned explicitly.
 * - `retry.retries: 8` covers broker hiccups. Handler errors never reach it, because consumers
 *   dead-letter them (`KafkaDeadLetterFilter`) instead of throwing (§5.5).
 * - `partitionsConsumedConcurrently` parallelises across partitions and keeps per-partition order.
 * - `autoCommit` stays on: Nest 12 awaits the handler before kafkajs resolves the offset, so it is
 *   at-least-once. Handlers must be idempotent (dedupe on the envelope id).
 */
export function createKafkaServerOptions(
  cfg: KafkaNamespaceConfig,
  extras: KafkaServerOptionsExtras = {},
): KafkaOptions {
  return {
    transport: Transport.KAFKA,
    options: {
      postfixId: '',
      client: createKafkaClientConfig(cfg),
      consumer: {
        groupId: extras.groupId ?? cfg.groupId,
        allowAutoTopicCreation: false,
        sessionTimeout: 30_000,
        heartbeatInterval: 3_000,
        rebalanceTimeout: 60_000,
        retry: { retries: 8 },
      },
      run: { partitionsConsumedConcurrently: cfg.partitionsConsumedConcurrently, autoCommit: true },
      subscribe: { fromBeginning: false },
      ...PRODUCER_OPTIONS,
    },
  };
}

/**
 * Producer-only client options for `KafkaProducerModule`. `producerOnlyMode` skips the consumer
 * group Nest would otherwise create for request/reply, and the `-producer` client id keeps it apart
 * from the consumer's connection in broker logs and quotas.
 */
export function createKafkaClientOptions(cfg: KafkaNamespaceConfig): KafkaOptions {
  return {
    transport: Transport.KAFKA,
    options: {
      postfixId: '',
      client: createKafkaClientConfig(cfg, `${cfg.clientId}-producer`),
      producerOnlyMode: true,
      ...PRODUCER_OPTIONS,
    },
  };
}

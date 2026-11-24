import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Transport } from '@nestjs/microservices';
import { kafkaConfig } from '@platform/config';
import { CompressionTypes, logLevel, Partitioners } from 'kafkajs';
import { describe, expect, it } from 'vitest';
import { KAFKA_DEAD_LETTER_SEND_TIMEOUT_MS } from './dead-letter.js';
import {
  createKafkaClientConfig,
  createKafkaClientOptions,
  createKafkaServerOptions,
  KAFKA_HEARTBEAT_INTERVAL_MS,
  KAFKA_REBALANCE_TIMEOUT_MS,
  KAFKA_SESSION_TIMEOUT_MS,
} from './kafka.options.js';
import { DEFAULT_KAFKA_RETRY_OPTIONS } from './kafka-retry.interceptor.js';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');

const cfg = kafkaConfig.parse({
  SERVICE_NAME: 'orders-service',
  KAFKA_BROKERS: 'k1:9092,k2:9092',
  KAFKA_CONSUMER_CONCURRENCY: '6',
});

describe('createKafkaClientConfig', () => {
  it('maps the namespace and sets no client-level retries (idempotent producer EoS)', () => {
    const client = createKafkaClientConfig(cfg);
    expect(client).toEqual({
      clientId: 'orders-service',
      brokers: ['k1:9092', 'k2:9092'],
      ssl: false,
      connectionTimeout: 3000,
      requestTimeout: 30_000,
      logLevel: logLevel.WARN,
      logCreator: expect.any(Function),
      retry: { initialRetryTime: 300, maxRetryTime: 30_000 },
    });
    expect(client.retry).not.toHaveProperty('retries');
  });

  it.each(['plain', 'scram-sha-256', 'scram-sha-512'] as const)(
    'passes SASL %s through',
    (mechanism) => {
      const secured = kafkaConfig.parse({
        KAFKA_SSL: 'true',
        KAFKA_SASL_MECHANISM: mechanism,
        KAFKA_SASL_USERNAME: 'svc',
        KAFKA_SASL_PASSWORD: 'secret',
      });
      expect(createKafkaClientConfig(secured, 'custom')).toMatchObject({
        clientId: 'custom',
        ssl: true,
        sasl: { mechanism, username: 'svc', password: 'secret' },
      });
    },
  );
});

describe('createKafkaServerOptions', () => {
  it('keeps ids verbatim and configures a safe consumer + idempotent producer', () => {
    const { transport, options } = createKafkaServerOptions(cfg);
    expect(transport).toBe(Transport.KAFKA);
    expect(options).toMatchObject({
      postfixId: '',
      consumer: {
        groupId: 'orders-service',
        allowAutoTopicCreation: false,
        sessionTimeout: 30_000,
        heartbeatInterval: 3_000,
        rebalanceTimeout: 60_000,
        retry: { retries: 8 },
      },
      run: { partitionsConsumedConcurrently: 6, autoCommit: true, autoCommitInterval: 5_000 },
      subscribe: { fromBeginning: false },
      producer: {
        idempotent: true,
        allowAutoTopicCreation: false,
        createPartitioner: Partitioners.DefaultPartitioner,
      },
      send: { acks: -1, compression: CompressionTypes.GZIP },
    });
    expect(options?.producerOnlyMode).toBeUndefined();
  });

  it('overrides the consumer group', () => {
    expect(
      createKafkaServerOptions(cfg, { groupId: 'gateway-push' }).options?.consumer?.groupId,
    ).toBe('gateway-push');
  });
});

/** The argument text of every `@KafkaConsumerController(...)` decorator in the repo's sources. */
function consumerControllerOptions(): { file: string; args: string }[] {
  const found: { file: string; args: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'dist', 'coverage', 'generated'].includes(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
        const text = readFileSync(path, 'utf8');
        for (const match of text.matchAll(/^@KafkaConsumerController\(/gm)) {
          // The argument runs to the matching parenthesis.
          let depth = 1;
          let end = (match.index ?? 0) + match[0].length;
          for (; end < text.length && depth > 0; end += 1) {
            if (text[end] === '(') depth += 1;
            else if (text[end] === ')') depth -= 1;
          }
          const start = (match.index ?? 0) + match[0].length;
          found.push({ file: relative(ROOT, path), args: text.slice(start, end - 1).trim() });
        }
      }
    }
  };
  for (const dir of ['apps', 'domains', 'libs']) walk(join(ROOT, dir));
  return found;
}

describe('consumer timing (B3-6)', () => {
  it('builds the consumer from the exported timing constants', () => {
    expect(createKafkaServerOptions(cfg).options.consumer).toMatchObject({
      sessionTimeout: KAFKA_SESSION_TIMEOUT_MS,
      heartbeatInterval: KAFKA_HEARTBEAT_INTERVAL_MS,
      rebalanceTimeout: KAFKA_REBALANCE_TIMEOUT_MS,
    });
  });

  it('fits three heartbeat intervals in the session', () => {
    // kafkajs skips a heartbeat asked for just under one interval after the last one, so a
    // heartbeat may be two intervals old when the next one goes out.
    expect(3 * KAFKA_HEARTBEAT_INTERVAL_MS).toBeLessThanOrEqual(KAFKA_SESSION_TIMEOUT_MS);
  });

  it('keeps every consumer controller: budget + dead-letter deadline + 10 s <= rebalance timeout', () => {
    const controllers = consumerControllerOptions();
    // Every @KafkaConsumerController in the repository: four at the time of writing.
    expect(controllers.length).toBeGreaterThanOrEqual(4);
    for (const { file, args } of controllers) {
      const literal = /\bbudgetMs:\s*([\d_]+)\s*[,}]/.exec(args)?.[1];
      // A budget this spec cannot read is a budget nobody checked: write it as a number literal.
      expect(args.includes('budgetMs') === (literal !== undefined), `${file}: ${args}`).toBe(true);
      const budgetMs =
        literal === undefined
          ? DEFAULT_KAFKA_RETRY_OPTIONS.budgetMs
          : Number(literal.replaceAll('_', ''));
      expect(
        budgetMs + KAFKA_DEAD_LETTER_SEND_TIMEOUT_MS + 10_000,
        `${file}: budgetMs ${budgetMs}`,
      ).toBeLessThanOrEqual(KAFKA_REBALANCE_TIMEOUT_MS);
    }
  });
});

describe('createKafkaClientOptions', () => {
  it('is producer-only, idempotent with acks -1 and a -producer client id', () => {
    const { options } = createKafkaClientOptions(cfg);
    expect(options).toMatchObject({
      postfixId: '',
      producerOnlyMode: true,
      client: { clientId: 'orders-service-producer', brokers: ['k1:9092', 'k2:9092'] },
      producer: { idempotent: true, createPartitioner: Partitioners.DefaultPartitioner },
      send: { acks: -1 },
    });
    expect(options?.consumer).toBeUndefined();
  });
});

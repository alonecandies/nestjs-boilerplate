import { kafkaConfig } from '@app/config';
import { Transport } from '@nestjs/microservices';
import { CompressionTypes, logLevel, Partitioners } from 'kafkajs';
import { describe, expect, it } from 'vitest';
import {
  createKafkaClientConfig,
  createKafkaClientOptions,
  createKafkaServerOptions,
} from './kafka.options.js';

const cfg = kafkaConfig.parse({
  SERVICE_NAME: 'identity-service',
  KAFKA_BROKERS: 'k1:9092,k2:9092',
  KAFKA_CONSUMER_CONCURRENCY: '6',
});

describe('createKafkaClientConfig', () => {
  it('maps the namespace and sets no client-level retries (idempotent producer EoS)', () => {
    const client = createKafkaClientConfig(cfg);
    expect(client).toEqual({
      clientId: 'identity-service',
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
        groupId: 'identity-service',
        allowAutoTopicCreation: false,
        sessionTimeout: 30_000,
        heartbeatInterval: 3_000,
        retry: { retries: 8 },
      },
      run: { partitionsConsumedConcurrently: 6, autoCommit: true },
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

describe('createKafkaClientOptions', () => {
  it('is producer-only, idempotent with acks -1 and a -producer client id', () => {
    const { options } = createKafkaClientOptions(cfg);
    expect(options).toMatchObject({
      postfixId: '',
      producerOnlyMode: true,
      client: { clientId: 'identity-service-producer', brokers: ['k1:9092', 'k2:9092'] },
      producer: { idempotent: true, createPartitioner: Partitioners.DefaultPartitioner },
      send: { acks: -1 },
    });
    expect(options?.consumer).toBeUndefined();
  });
});

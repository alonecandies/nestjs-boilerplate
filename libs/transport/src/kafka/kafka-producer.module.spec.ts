import { AppConfigModule, appConfig } from '@app/config';
import { type INestApplicationContext, Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ClientKafka } from '@nestjs/microservices';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KAFKA_PRODUCER_CLIENT, KAFKA_PRODUCER_OPTIONS } from './kafka.constants.js';
import { KafkaHealthIndicator } from './kafka.health.js';
import { KafkaProducerModule } from './kafka-producer.module.js';
import { KafkaProducer, type KafkaProducerOptions } from './kafka-producer.service.js';

@Module({
  imports: [
    AppConfigModule.forRoot(),
    // No broker in unit tests: skip the boot-time connect.
    KafkaProducerModule.forRootAsync({ eagerConnect: false }),
  ],
})
class TestRootModule {}

describe('KafkaProducerModule (DI wiring, no broker)', () => {
  let app: INestApplicationContext;

  beforeAll(async () => {
    Logger.overrideLogger(false);
    app = await NestFactory.createApplicationContext(TestRootModule, { logger: false });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('provides a producer-only ClientKafka, the producer and the health indicator', () => {
    expect(app.get(KAFKA_PRODUCER_CLIENT)).toBeInstanceOf(ClientKafka);
    expect(app.get(KafkaProducer)).toBeInstanceOf(KafkaProducer);
    expect(app.get(KafkaHealthIndicator)).toBeInstanceOf(KafkaHealthIndicator);
  });

  it('defaults the envelope source to appConfig.serviceName', () => {
    expect(app.get<KafkaProducerOptions>(KAFKA_PRODUCER_OPTIONS)).toMatchObject({
      source: appConfig.parse().serviceName,
      eagerConnect: false,
    });
  });

  it('builds valid records without a broker', () => {
    const record = app.get(KafkaProducer).createRecord('identity.user-registered.v1', {
      userId: '0199d1c6-5d7e-7a4e-8c3b-2f1e0d9c8b7a',
      email: 'ada@example.com',
      displayName: 'Ada',
      registeredAt: '2026-09-01T10:00:00.000Z',
    });
    expect(record.value.source).toBe(appConfig.parse().serviceName);
  });
});

import { billingSchema } from '@app/billing';
import { buildFastifyOptions, configureHttpApp, setupApiDocs } from '@app/bootstrap';
import { CASSANDRA_CLIENT } from '@app/cassandra';
import { appConfig } from '@app/config';
import { DRIZZLE } from '@app/database';
import { GRAPHQL_PUB_SUB } from '@app/graphql';
import {
  identitySchema,
  SessionsRepository,
  TransactionRunner,
  UsersRepository,
} from '@app/identity';
import { MAIL_QUEUE, MailProcessor } from '@app/mailer';
import { REDIS_CLIENT } from '@app/redis';
import { InMemoryRedis } from '@app/redis/testing';
import { InMemoryStorageService, StorageService } from '@app/storage';
import { createFastifyTestApp } from '@app/testing';
import { FakeKafkaProducer, KafkaProducer } from '@app/transport';
import { getQueueToken } from '@nestjs/bullmq';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { PubSub } from 'graphql-subscriptions';
import { MONOLITH_API_DOCS } from '../../src/app.constants.js';
import { AppModule } from '../../src/app.module.js';
import {
  createFakeCassandra,
  createFakePostgres,
  createFakeQueue,
  createL1OnlyCache,
} from './fake-infrastructure.js';
import { createInMemoryIdentityPersistence } from './in-memory-identity.js';

export type MonolithE2e = Awaited<ReturnType<typeof createMonolithE2eApp>>;

/**
 * Boots the REAL `AppModule` with the production HTTP wiring (`buildFastifyOptions` +
 * `configureHttpApp` + `setupApiDocs`, raw body + multipart like `main.ts`) and fakes only at the
 * network edges:
 *
 * | provider                                   | fake                                         |
 * |--------------------------------------------|----------------------------------------------|
 * | `REDIS_CLIENT` (denylist, throttler, locks) | `InMemoryRedis`                              |
 * | `DRIZZLE`                                  | real drizzle over a fake postgres.js client  |
 * | identity repositories + TransactionRunner  | in-memory (the handlers above them are real) |
 * | `CASSANDRA_CLIENT`                         | empty result sets                            |
 * | BullMQ `mail` queue / `MailProcessor`      | recording queue / no worker                  |
 * | `CACHE_MANAGER`                            | real L1 tier only (L2 is node-redis)         |
 * | `KafkaProducer`                            | `FakeKafkaProducer` (records envelopes)      |
 * | `GRAPHQL_PUB_SUB`                          | in-process `PubSub`                          |
 * | `StorageService`                           | `InMemoryStorageService`                     |
 *
 * The Kafka consumer and the Redis Socket.IO adapter are not connected (no broker / Redis).
 */
export async function createMonolithE2eApp() {
  const config = appConfig.parse();
  const redis = new InMemoryRedis();
  const kafka = new FakeKafkaProducer({ source: config.serviceName });
  const identity = createInMemoryIdentityPersistence();
  const postgres = createFakePostgres({ ...identitySchema, ...billingSchema });
  const cassandra = createFakeCassandra();
  const mailQueue = createFakeQueue();
  const storage = new InMemoryStorageService();

  const builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(REDIS_CLIENT)
    .useValue(redis.asRedis())
    .overrideProvider(DRIZZLE)
    .useValue(postgres.db)
    .overrideProvider(UsersRepository)
    .useValue(identity.users)
    .overrideProvider(SessionsRepository)
    .useValue(identity.sessions)
    .overrideProvider(TransactionRunner)
    .useValue(identity.transactions)
    .overrideProvider(CASSANDRA_CLIENT)
    .useValue(cassandra.client)
    .overrideProvider(getQueueToken(MAIL_QUEUE))
    .useValue(mailQueue)
    // A plain value is not a @Processor for BullMQ's explorer → no Worker connecting to Redis.
    .overrideProvider(MailProcessor)
    .useValue({})
    .overrideProvider(CACHE_MANAGER)
    .useValue(createL1OnlyCache())
    .overrideProvider(KafkaProducer)
    .useValue(kafka)
    .overrideProvider(GRAPHQL_PUB_SUB)
    .useValue(new PubSub())
    .overrideProvider(StorageService)
    .useValue(storage);

  const app: NestFastifyApplication = await createFastifyTestApp(
    builder,
    async (created) => {
      await configureHttpApp(created, { config, shutdownHooks: false, processHandlers: false });
      setupApiDocs(created, MONOLITH_API_DOCS);
    },
    {
      adapter: new FastifyAdapter(buildFastifyOptions(config, { multipart: true })),
      appOptions: { bufferLogs: true, rawBody: true },
    },
  );

  return { app, redis, kafka, identity, postgres, cassandra, mailQueue, storage };
}

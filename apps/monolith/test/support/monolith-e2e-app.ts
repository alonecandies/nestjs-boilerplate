import { billingSchema } from '@domain/billing';
import {
  identitySchema,
  SessionsRepository,
  TransactionRunner,
  UsersRepository,
} from '@domain/identity';
import { createInMemoryIdentityPersistence } from '@domain/identity/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { buildFastifyOptions, configureHttpApp, setupApiDocs } from '@platform/bootstrap';
import { CASSANDRA_CLIENT } from '@platform/cassandra';
import { appConfig } from '@platform/config';
import { DRIZZLE } from '@platform/database';
import { GRAPHQL_PUB_SUB } from '@platform/graphql';
import { MAIL_QUEUE, MailProcessor } from '@platform/mailer';
import { REDIS_CLIENT } from '@platform/redis';
import { InMemoryRedis } from '@platform/redis/testing';
import { InMemoryStorageService, StorageService } from '@platform/storage';
import { createFastifyTestApp } from '@platform/testing';
import { FakeKafkaProducer, KafkaProducer } from '@platform/transport';
import { PubSub } from 'graphql-subscriptions';
import { MONOLITH_API_DOCS } from '../../src/app.constants.js';
import { AppModule } from '../../src/app.module.js';
import {
  createFakeCassandra,
  createFakePostgres,
  createFakeQueue,
  createL1OnlyCache,
  type FakeRows,
} from './fake-infrastructure.js';

export type MonolithE2e = Awaited<ReturnType<typeof createMonolithE2eApp>>;

/**
 * Boots the REAL `AppModule` with the production HTTP wiring (`buildFastifyOptions` +
 * `configureHttpApp` + `setupApiDocs`, raw body + multipart like `main.ts`) and fakes only at the
 * network edges:
 *
 * | provider                                   | fake                                         |
 * |--------------------------------------------|----------------------------------------------|
 * | `REDIS_CLIENT` (denylist, throttler, locks) | `InMemoryRedis`                              |
 * | `DRIZZLE`                                  | real drizzle over a fake postgres.js client (rows: `options.postgresRows`) |
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
export interface MonolithE2eOptions {
  /** Rows the fake Postgres answers a statement with (`sql` whitespace-normalised); default none. */
  postgresRows?: (sql: string, params: unknown[]) => FakeRows;
}

export async function createMonolithE2eApp(options: MonolithE2eOptions = {}) {
  const config = appConfig.parse();
  const redis = new InMemoryRedis();
  const kafka = new FakeKafkaProducer({ source: config.serviceName });
  const identity = createInMemoryIdentityPersistence();
  const postgres = createFakePostgres(
    { ...identitySchema, ...billingSchema },
    options.postgresRows,
  );
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

import {
  BillingOutbox,
  BillingOutboxSystemRepository,
  billingSchema,
  StripeEventsSystemRepository,
} from '@domain/billing';
import {
  createInMemoryBillingOutbox,
  InMemoryStripeEventsSystemRepository,
} from '@domain/billing/testing';
import {
  AuditEventsRepository,
  IdentityOutbox,
  IdentityOutboxSystemRepository,
  InvitationsRepository,
  InvitationsSystemRepository,
  identitySchema,
  MembershipsRepository,
  MembershipsSystemRepository,
  SessionsRepository,
  SessionsSystemRepository,
  TenantsRepository,
  TransactionRunner,
  UsersRepository,
  UsersSystemRepository,
} from '@domain/identity';
import { createInMemoryIdentityPersistence } from '@domain/identity/testing';
import { NotificationRecipientsRepository, NotificationsRepository } from '@domain/notifications';
import {
  InMemoryNotificationRecipientsRepository,
  InMemoryNotificationsRepository,
} from '@domain/notifications/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Type } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { buildFastifyOptions, configureHttpApp, setupApiDocs } from '@platform/bootstrap';
import { CASSANDRA_CLIENT } from '@platform/cassandra';
import { appConfig } from '@platform/config';
import { DRIZZLE, RlsElevation } from '@platform/database';
import { GRAPHQL_PUB_SUB } from '@platform/graphql';
import { ImmudbClient } from '@platform/immudb';
import { MAIL_QUEUE, MailProcessor } from '@platform/mailer';
import { type OutboxRelay, type OutboxTickResult, outboxRelayToken } from '@platform/outbox';
import { REDIS_CLIENT } from '@platform/redis';
import { InMemoryRedis } from '@platform/redis/testing';
import { StorageService } from '@platform/storage';
import { InMemoryStorageService } from '@platform/storage/testing';
import { createFastifyTestApp } from '@platform/testing';
import { KafkaProducer } from '@platform/transport';
import { FakeKafkaProducer } from '@platform/transport/testing';
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
import { InMemoryKafkaServer } from './in-memory-kafka.server.js';

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
 * | identity tenancy repositories                | in-memory (same store as users and sessions) |
 * | `StripeEventsSystemRepository`             | in-memory (no app_system pool)               |
 * | `RlsElevation`                             | `InMemoryRlsElevation` (no transaction to elevate) |
 * | `NotificationsRepository`, `NotificationRecipientsRepository` | in-memory, keyed by (tenant, user); `notificationStores: 'cassandra'` keeps the real adapters over the fake client |
 * | `CASSANDRA_CLIENT`                         | empty result sets                            |
 * | BullMQ `mail` queue / `MailProcessor`      | recording queue / no worker                  |
 * | `CACHE_MANAGER`                            | real L1 tier only (L2 is node-redis)         |
 * | `KafkaProducer`                            | `FakeKafkaProducer` (records envelopes)      |
 * | `IdentityOutbox` + its system repository   | `InMemoryOutbox` (`outbox.identity`)         |
 * | `BillingOutbox` + its system repository    | `InMemoryOutbox` (`outbox.billing`)          |
 * | `GRAPHQL_PUB_SUB`                          | in-process `PubSub`                          |
 * | `StorageService`                           | `InMemoryStorageService`                     |
 * | `ImmudbClient` (`LEDGER_ENABLED=true` only) | `options.immudb`, when given                 |
 *
 * The Redis Socket.IO adapter is not connected (no Redis). The Kafka consumers are connected only
 * with `kafkaConsumers: true`, to an in-process server (`consumers.deliver()`), never to a broker.
 *
 * Outbox: the request path writes integration events to the in-memory outboxes and publishes
 * nothing. The app's own relays (one per outbox) never start (`OUTBOX_RELAY_ENABLED=false` and no
 * system pool); a spec drives them with `tickRelays()`, which publishes to the fake producer.
 */
export interface MonolithE2eOptions {
  /** Rows the fake Postgres answers a statement with (`sql` whitespace-normalised); default none. */
  postgresRows?: (sql: string, params: unknown[]) => FakeRows;
  /**
   * What holds the notifications inbox and the recipients projection. `'in-memory'` (default)
   * binds the in-memory repositories, which keep state per `(tenantId, userId)`; `'cassandra'`
   * keeps the real adapters over the fake client, which answers every query with no rows (for a
   * spec that asserts the CQL the adapters send).
   */
  notificationStores?: 'in-memory' | 'cassandra';
  /**
   * Connects the app's Kafka consumers (`@KafkaEventPattern` handlers, as `connectKafkaConsumer`
   * does in main.ts) to an in-process `InMemoryKafkaServer`, returned as `consumers`.
   */
  kafkaConsumers?: boolean;
  /**
   * The root module to boot instead of `AppModule`: one `createAppModule()` defined after the spec
   * stubbed the env it reads at definition time (`LEDGER_ENABLED`).
   */
  module?: Type<unknown>;
  /** Replaces the `ImmudbClient` of `ImmudbModule` (loaded only with `LEDGER_ENABLED=true`). */
  immudb?: ImmudbClient;
}

export async function createMonolithE2eApp(options: MonolithE2eOptions = {}) {
  const config = appConfig.parse();
  const redis = new InMemoryRedis();
  const kafka = new FakeKafkaProducer({ source: config.serviceName });
  // The outboxes build their envelopes with the app's producer (source = SERVICE_NAME).
  const identity = createInMemoryIdentityPersistence(undefined, { kafka });
  const billingOutbox = createInMemoryBillingOutbox({ kafka });
  const consumers = new InMemoryKafkaServer();
  const postgres = createFakePostgres(
    { ...identitySchema, ...billingSchema },
    options.postgresRows,
  );
  const cassandra = createFakeCassandra();
  const notifications = new InMemoryNotificationsRepository();
  const recipients = new InMemoryNotificationRecipientsRepository();
  const mailQueue = createFakeQueue();
  const storage = new InMemoryStorageService();

  const builder = Test.createTestingModule({ imports: [options.module ?? AppModule] })
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
    .overrideProvider(TenantsRepository)
    .useValue(identity.tenants)
    .overrideProvider(MembershipsRepository)
    .useValue(identity.memberships)
    .overrideProvider(InvitationsRepository)
    .useValue(identity.invitations)
    .overrideProvider(AuditEventsRepository)
    .useValue(identity.auditEvents)
    // The system ports (app_system pool) read the same in-memory store.
    .overrideProvider(UsersSystemRepository)
    .useValue(identity.usersSystem)
    .overrideProvider(MembershipsSystemRepository)
    .useValue(identity.membershipsSystem)
    .overrideProvider(InvitationsSystemRepository)
    .useValue(identity.invitationsSystem)
    .overrideProvider(SessionsSystemRepository)
    .useValue(identity.sessionsSystem)
    // The real RlsElevation needs an open runtime transaction; the inline runner opens none.
    .overrideProvider(RlsElevation)
    .useValue(identity.elevation)
    // Each outbox is one in-memory array: the writer and the relay's system repository.
    .overrideProvider(IdentityOutbox)
    .useValue(identity.outbox)
    .overrideProvider(IdentityOutboxSystemRepository)
    .useValue(identity.outbox)
    .overrideProvider(BillingOutbox)
    .useValue(billingOutbox)
    .overrideProvider(BillingOutboxSystemRepository)
    .useValue(billingOutbox)
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
    .useValue(storage)
    .overrideProvider(StripeEventsSystemRepository)
    .useValue(new InMemoryStripeEventsSystemRepository());

  if (options.immudb !== undefined) {
    builder.overrideProvider(ImmudbClient).useValue(options.immudb);
  }

  if (options.notificationStores !== 'cassandra') {
    builder
      .overrideProvider(NotificationsRepository)
      .useValue(notifications)
      .overrideProvider(NotificationRecipientsRepository)
      .useValue(recipients);
  }

  const app: NestFastifyApplication = await createFastifyTestApp(
    builder,
    async (created) => {
      await configureHttpApp(created, { config, shutdownHooks: false, processHandlers: false });
      setupApiDocs(created, MONOLITH_API_DOCS);
      if (options.kafkaConsumers === true) {
        created.connectMicroservice({ strategy: consumers }, { inheritAppConfig: true });
      }
    },
    {
      adapter: new FastifyAdapter(buildFastifyOptions(config, { multipart: true })),
      appOptions: { bufferLogs: true, rawBody: true },
    },
  );

  if (options.kafkaConsumers === true) await app.startAllMicroservices();

  const relays = {
    identity: app.get<string, OutboxRelay>(outboxRelayToken('identity'), { strict: false }),
    billing: app.get<string, OutboxRelay>(outboxRelayToken('billing'), { strict: false }),
  };
  /** One tick of each relay (identity, then billing): poll → publish → mark. */
  const tickRelays = async (): Promise<[OutboxTickResult, OutboxTickResult]> => {
    const signal = new AbortController().signal;
    return [await relays.identity.tick(signal), await relays.billing.tick(signal)];
  };
  /**
   * Publishes everything the outboxes hold (ticks until both are empty), then forgets what the
   * fake producer recorded: the next assertion sees only what comes after this point.
   */
  const flushOutboxes = async (): Promise<void> => {
    for (let round = 0; round < 10; round += 1) {
      const results = await tickRelays();
      if (results.some((result) => result.failed)) throw new Error('an outbox relay tick failed');
      if (identity.outbox.unpublished().length + billingOutbox.unpublished().length === 0) break;
    }
    kafka.clear();
  };

  return {
    app,
    redis,
    kafka,
    identity,
    outbox: { identity: identity.outbox, billing: billingOutbox },
    relays,
    tickRelays,
    flushOutboxes,
    consumers,
    postgres,
    cassandra,
    notifications,
    recipients,
    mailQueue,
    storage,
  };
}

import { AuthModule } from '@app/auth';
import { CASSANDRA_CLIENT, type CassandraClient } from '@app/cassandra';
import { AppConfigModule } from '@app/config';
import { KAFKA_TOPICS } from '@app/contracts';
import { GraphqlPubSubModule } from '@app/graphql';
import { MailService } from '@app/mailer';
import { AppThrottlerModule } from '@app/redis';
import { createMock } from '@app/testing';
import { FakeKafkaProducer, KafkaProducer } from '@app/transport';
import { Global, Module, type Type } from '@nestjs/common';
import { CommandBus, CqrsModule, QueryBus } from '@nestjs/cqrs';
import { Test, type TestingModule } from '@nestjs/testing';
import type cassandra from 'cassandra-driver';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeRedisModule } from '../test/support/edge-test-app.js';
import { USER_ID } from '../test/support/fixtures.js';
import { WelcomeUserCommand } from './application/commands/welcome-user/welcome-user.command.js';
import { NotificationsPort } from './application/ports/notifications.port.js';
import { ListNotificationsQuery } from './application/queries/list-notifications/list-notifications.query.js';
import { NotificationsGrpcAdapter } from './infrastructure/adapters/grpc/notifications-grpc.adapter.js';
import { NotificationsLocalAdapter } from './infrastructure/adapters/local/notifications-local.adapter.js';
import { NotificationsApiModule } from './notifications-api.module.js';
import { NotificationsCoreModule } from './notifications-core.module.js';
import { NotificationsGrpcModule } from './notifications-grpc.module.js';
import { NotificationsMessagingModule } from './notifications-messaging.module.js';
import { NotificationsGrpcController } from './presentation/grpc/notifications-grpc.controller.js';
import { BillingEventsConsumer } from './presentation/messaging/billing-events.consumer.js';
import { IdentityEventsConsumer } from './presentation/messaging/identity-events.consumer.js';
import { NotificationPushConsumer } from './presentation/messaging/notification-push.consumer.js';
import { NotificationsGateway } from './presentation/ws/notifications.gateway.js';

/** What the apps provide globally for the core: Cassandra, the Kafka producer, the mail queue. */
function fakeInfrastructure() {
  const cassandraClient = createMock<CassandraClient>({
    execute: async () =>
      ({
        rows: [],
        pageState: null,
        wasApplied: () => true,
      }) as unknown as cassandra.types.ResultSet,
  });
  const kafka = new FakeKafkaProducer({ source: 'notifications-test' });
  const mail = createMock<MailService>({ enqueue: async () => ({ jobId: 'job' }) });

  @Global()
  @Module({
    providers: [
      { provide: CASSANDRA_CLIENT, useValue: cassandraClient },
      { provide: KafkaProducer, useValue: kafka },
      { provide: MailService, useValue: mail },
    ],
    exports: [CASSANDRA_CLIENT, KafkaProducer, MailService],
  })
  class FakeInfrastructureModule {}

  return { cassandraClient, kafka, mail, FakeInfrastructureModule };
}

/** Edge globals the Api module expects (auth for the gateway, PubSub for resolver + push). */
const EDGE_GLOBALS = [
  AppConfigModule.forRoot(),
  FakeRedisModule,
  AuthModule.forRootAsync(),
  // WsThrottlerGuard (gateway) needs the throttler options + storage.
  AppThrottlerModule.forRootAsync({ globalGuard: false }),
  GraphqlPubSubModule.forRootAsync({ inMemory: true }),
];

/** Controllers are resolvable like providers once the module graph is compiled. */
const hasInstance = (moduleRef: TestingModule, type: Type): boolean =>
  moduleRef.get(type, { strict: false }) instanceof type;

describe('notifications modules (composition, no infrastructure)', () => {
  let moduleRef: TestingModule | undefined;

  afterEach(async () => {
    await moduleRef?.close();
    moduleRef = undefined;
  });

  it('NotificationsCoreModule: welcome flow runs command → aggregate → saga → Kafka', async () => {
    const infra = fakeInfrastructure();
    moduleRef = await Test.createTestingModule({
      imports: [CqrsModule.forRoot(), infra.FakeInfrastructureModule, NotificationsCoreModule],
    }).compile();
    await moduleRef.init();

    const notification = await moduleRef.get(CommandBus).execute(
      new WelcomeUserCommand({
        userId: USER_ID,
        email: 'ada@example.com',
        displayName: 'Ada',
        registeredAt: new Date('2026-09-29T07:00:00.000Z'),
      }),
    );

    expect(notification).toMatchObject({ userId: USER_ID, type: 'welcome', read: false });
    // recipient upsert + inbox insert hit Cassandra; the mail is queued.
    expect(infra.cassandraClient.execute).toHaveBeenCalledTimes(2);
    expect(infra.mail.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ template: 'welcome', idempotencyKey: `welcome-${USER_ID}` }),
    );
    // The saga publishes asynchronously on the event stream.
    await vi.waitFor(() =>
      expect(infra.kafka.envelopes(KAFKA_TOPICS.NOTIFICATION_CREATED)).toHaveLength(1),
    );
    expect(infra.kafka.envelopes(KAFKA_TOPICS.NOTIFICATION_CREATED)[0]).toMatchObject({
      id: notification.id,
      payload: { notificationId: notification.id, userId: USER_ID, type: 'welcome' },
    });

    await expect(
      moduleRef.get(QueryBus).execute(new ListNotificationsQuery(USER_ID, 10)),
    ).resolves.toEqual({ items: [] });
  });

  it('NotificationsGrpcModule and NotificationsMessagingModule register their controllers', async () => {
    const infra = fakeInfrastructure();
    moduleRef = await Test.createTestingModule({
      imports: [
        CqrsModule.forRoot(),
        infra.FakeInfrastructureModule,
        NotificationsGrpcModule,
        NotificationsMessagingModule,
      ],
    }).compile();

    for (const controller of [
      NotificationsGrpcController,
      IdentityEventsConsumer,
      BillingEventsConsumer,
    ]) {
      expect(hasInstance(moduleRef, controller)).toBe(true);
    }
  });

  it('NotificationsApiModule.forLocal() binds the port to the CQRS buses', async () => {
    const infra = fakeInfrastructure();
    moduleRef = await Test.createTestingModule({
      imports: [
        CqrsModule.forRoot(),
        infra.FakeInfrastructureModule,
        ...EDGE_GLOBALS,
        NotificationsApiModule.forLocal(),
      ],
    }).compile();

    expect(moduleRef.get(NotificationsPort, { strict: false })).toBeInstanceOf(
      NotificationsLocalAdapter,
    );
    expect(hasInstance(moduleRef, NotificationsGateway)).toBe(true);
    expect(hasInstance(moduleRef, NotificationPushConsumer)).toBe(true);
  });

  it('NotificationsApiModule.forRemote() binds the port to the gRPC client (no core, no Cassandra)', async () => {
    moduleRef = await Test.createTestingModule({
      imports: [...EDGE_GLOBALS, NotificationsApiModule.forRemote()],
    }).compile();
    await moduleRef.init();

    expect(moduleRef.get(NotificationsPort, { strict: false })).toBeInstanceOf(
      NotificationsGrpcAdapter,
    );
    expect(() => moduleRef?.get(NotificationsCoreModule, { strict: false })).toThrow();
  });
});

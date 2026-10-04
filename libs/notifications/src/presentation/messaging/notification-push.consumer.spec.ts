import { createEventEnvelope, KAFKA_TOPICS, type NotificationCreatedPayload } from '@app/contracts';
import { GRAPHQL_PUB_SUB } from '@app/graphql';
import { Test } from '@nestjs/testing';
import { PubSub } from 'graphql-subscriptions';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from 'vitest';
import { CREATED_AT, USER_ID } from '../../../test/support/fixtures.js';
import { InMemoryKafkaServer } from '../../../test/support/in-memory-kafka.server.js';
import { NOTIFICATION_CREATED_TRIGGER } from '../../notifications.constants.js';
import { NotificationsGateway } from '../ws/notifications.gateway.js';
import { NotificationPushConsumer } from './notification-push.consumer.js';

const NOTIFICATION_ID = '01920000-0000-7000-8000-00000000abcd';
const payload: NotificationCreatedPayload = {
  notificationId: NOTIFICATION_ID,
  userId: USER_ID,
  type: 'payment_receipt',
  title: 'Payment received',
  body: 'We received your payment of $19.99. Thank you!',
  data: { paymentId: 'p1' },
  createdAt: CREATED_AT.toISOString(),
};

describe('NotificationPushConsumer (edge fan-out)', () => {
  const gateway = { pushToUser: vi.fn() };
  const pubSub = new PubSub();
  // The root config sets restoreMocks: spies must be (re)created per test.
  let publish: MockInstance<PubSub['publish']>;
  const server = new InMemoryKafkaServer();
  let close: () => Promise<void>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [NotificationPushConsumer],
      providers: [
        { provide: NotificationsGateway, useValue: gateway },
        { provide: GRAPHQL_PUB_SUB, useValue: pubSub },
      ],
    }).compile();
    const microservice = moduleRef.createNestMicroservice({ strategy: server, logger: false });
    await microservice.init();
    close = () => microservice.close();
  });

  afterAll(async () => {
    await close();
  });

  beforeEach(() => {
    gateway.pushToUser.mockReset();
    publish = vi.spyOn(pubSub, 'publish');
    server.producer.send.mockClear();
  });

  it('pushes to the user room (REST shape) and publishes the GraphQL trigger', async () => {
    const envelope = createEventEnvelope(KAFKA_TOPICS.NOTIFICATION_CREATED, payload, {
      id: NOTIFICATION_ID,
      source: 'notifications-service',
    });

    await server.dispatch(KAFKA_TOPICS.NOTIFICATION_CREATED, envelope, USER_ID);

    expect(gateway.pushToUser).toHaveBeenCalledWith(USER_ID, {
      id: NOTIFICATION_ID,
      type: 'payment_receipt',
      title: payload.title,
      body: payload.body,
      read: false,
      data: { paymentId: 'p1' },
      createdAt: CREATED_AT.toISOString(),
    });
    expect(publish).toHaveBeenCalledWith(NOTIFICATION_CREATED_TRIGGER, payload);
    expect(server.deadLetters()).toHaveLength(0);
  });

  it('dead-letters a malformed event and pushes nothing', async () => {
    await server.dispatch(KAFKA_TOPICS.NOTIFICATION_CREATED, { hello: 'world' });
    expect(gateway.pushToUser).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(server.deadLetters()[0]?.topic).toBe(`${KAFKA_TOPICS.NOTIFICATION_CREATED}.dlq`);
  });
});

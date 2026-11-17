import {
  NOTIFICATION_CREATED_EVENT,
  type NotificationCreatedPayload,
} from '@domain/notifications-contracts';
import { Test } from '@nestjs/testing';
import { generateId, PLATFORM_TENANT_ID } from '@platform/common';
import { redisConfig } from '@platform/config';
import { createEventEnvelope } from '@platform/contracts';
import { GRAPHQL_PUB_SUB } from '@platform/graphql';
import { REDIS_CLIENT, RedisKeyService } from '@platform/redis';
import { InMemoryRedis } from '@platform/redis/testing';
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
import { CREATED_AT, OTHER_TENANT_ID, TENANT_ID, USER_ID } from '../../../test/support/fixtures.js';
import { InMemoryKafkaServer } from '../../../test/support/in-memory-kafka.server.js';
import { notificationCreatedTrigger } from '../../notifications.constants.js';
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

const withoutTenant = <T extends { tenantId?: string | undefined }>(envelope: T) => {
  const { tenantId: _tenantId, ...rest } = envelope;
  return rest;
};

describe('NotificationPushConsumer (edge fan-out)', () => {
  const gateway = { pushToUser: vi.fn() };
  const pubSub = new PubSub();
  const redis = new InMemoryRedis().asRedis();
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
        { provide: REDIS_CLIENT, useValue: redis },
        { provide: RedisKeyService, useValue: new RedisKeyService(redisConfig.parse()) },
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

  it('pushes to the (envelope tenant, payload user) room (REST shape) and publishes the (tenant, user) trigger', async () => {
    const envelope = createEventEnvelope(NOTIFICATION_CREATED_EVENT, payload, {
      id: NOTIFICATION_ID,
      source: 'notifications-service',
      tenantId: TENANT_ID,
    });

    await server.dispatch(NOTIFICATION_CREATED_EVENT.topic, envelope, USER_ID);

    expect(gateway.pushToUser).toHaveBeenCalledOnce();
    expect(gateway.pushToUser).toHaveBeenCalledWith(TENANT_ID, USER_ID, {
      id: NOTIFICATION_ID,
      type: 'payment_receipt',
      title: payload.title,
      body: payload.body,
      read: false,
      data: { paymentId: 'p1' },
      createdAt: CREATED_AT.toISOString(),
    });
    // The published object carries the envelope tenant: the subscription filter sees it.
    expect(publish).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith(`notificationCreated:${TENANT_ID}:${USER_ID}`, {
      ...payload,
      tenantId: TENANT_ID,
    });
    expect(publish).toHaveBeenCalledWith(notificationCreatedTrigger(TENANT_ID, USER_ID), {
      ...payload,
      tenantId: TENANT_ID,
    });
    expect(server.deadLetters()).toHaveLength(0);
  });

  it('addresses the push by the envelope tenant (another tenant, same user)', async () => {
    const envelope = createEventEnvelope(NOTIFICATION_CREATED_EVENT, payload, {
      id: generateId(),
      source: 'notifications-service',
      tenantId: OTHER_TENANT_ID,
    });

    await server.dispatch(NOTIFICATION_CREATED_EVENT.topic, envelope, USER_ID);

    expect(gateway.pushToUser).toHaveBeenCalledOnce();
    expect(gateway.pushToUser).toHaveBeenCalledWith(OTHER_TENANT_ID, USER_ID, expect.anything());
    expect(publish).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith(`notificationCreated:${OTHER_TENANT_ID}:${USER_ID}`, {
      ...payload,
      tenantId: OTHER_TENANT_ID,
    });
  });

  it('dead-letters an envelope without tenantId before the dedupe claim and pushes nothing', async () => {
    const set = vi.spyOn(redis, 'set');
    const envelope = createEventEnvelope(NOTIFICATION_CREATED_EVENT, payload, {
      id: generateId(),
      source: 'notifications-service',
      tenantId: TENANT_ID,
    });

    await server.dispatch(NOTIFICATION_CREATED_EVENT.topic, withoutTenant(envelope), USER_ID);

    expect(set).not.toHaveBeenCalled();
    expect(gateway.pushToUser).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(server.deadLetters().at(-1)?.topic).toBe(`${NOTIFICATION_CREATED_EVENT.topic}.dlq`);

    // Nothing was claimed: the same envelope id with its tenant still pushes.
    await server.dispatch(NOTIFICATION_CREATED_EVENT.topic, envelope, USER_ID);
    expect(gateway.pushToUser).toHaveBeenCalledOnce();
    expect(gateway.pushToUser).toHaveBeenCalledWith(TENANT_ID, USER_ID, expect.anything());
  });

  it('dead-letters an envelope for the platform (nil) tenant and pushes nothing', async () => {
    const envelope = {
      ...createEventEnvelope(NOTIFICATION_CREATED_EVENT, payload, {
        id: generateId(),
        source: 'notifications-service',
        tenantId: TENANT_ID,
      }),
      tenantId: PLATFORM_TENANT_ID,
    };

    await server.dispatch(NOTIFICATION_CREATED_EVENT.topic, envelope, USER_ID);

    expect(gateway.pushToUser).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(server.deadLetters().at(-1)?.topic).toBe(`${NOTIFICATION_CREATED_EVENT.topic}.dlq`);
  });

  it('dead-letters a malformed event and pushes nothing', async () => {
    await server.dispatch(NOTIFICATION_CREATED_EVENT.topic, { hello: 'world' });
    expect(gateway.pushToUser).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(server.deadLetters()[0]?.topic).toBe(`${NOTIFICATION_CREATED_EVENT.topic}.dlq`);
  });

  it('pushes a redelivered event (same envelope id) only once', async () => {
    const envelope = createEventEnvelope(NOTIFICATION_CREATED_EVENT, payload, {
      id: generateId(),
      source: 'notifications-service',
      tenantId: TENANT_ID,
    });

    await server.dispatch(NOTIFICATION_CREATED_EVENT.topic, envelope, USER_ID);
    await server.dispatch(NOTIFICATION_CREATED_EVENT.topic, envelope, USER_ID);

    expect(gateway.pushToUser).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledOnce();
    expect(server.deadLetters()).toHaveLength(0);
  });

  it('fails open: pushes anyway when the dedupe store is unavailable', async () => {
    vi.spyOn(redis, 'set').mockRejectedValueOnce(new Error('Connection is closed.'));
    const envelope = createEventEnvelope(NOTIFICATION_CREATED_EVENT, payload, {
      id: generateId(),
      source: 'notifications-service',
      tenantId: TENANT_ID,
    });

    await server.dispatch(NOTIFICATION_CREATED_EVENT.topic, envelope, USER_ID);

    expect(gateway.pushToUser).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledOnce();
    expect(server.deadLetters()).toHaveLength(0);
  });
});

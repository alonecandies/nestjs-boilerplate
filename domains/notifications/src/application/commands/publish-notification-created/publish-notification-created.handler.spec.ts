import { NOTIFICATION_CREATED_EVENT } from '@domain/notifications-contracts';
import { FakeKafkaProducer } from '@platform/transport';
import { describe, expect, it } from 'vitest';
import { makeNotificationProps } from '../../../../test/support/fixtures.js';
import { PublishNotificationCreatedCommand } from './publish-notification-created.command.js';
import { PublishNotificationCreatedHandler } from './publish-notification-created.handler.js';

describe('PublishNotificationCreatedHandler', () => {
  it('publishes a validated notification-created envelope keyed by user, id = notification id', async () => {
    const kafka = new FakeKafkaProducer({ source: 'notifications-test' });
    const notification = makeNotificationProps({ type: 'welcome' });

    const published = await new PublishNotificationCreatedHandler(kafka).execute(
      new PublishNotificationCreatedCommand(notification),
    );

    expect(published).toBe(true);
    const [record] = kafka.published(NOTIFICATION_CREATED_EVENT);
    expect(record?.key).toBe(notification.userId);
    expect(record?.value).toMatchObject({
      id: notification.id,
      type: NOTIFICATION_CREATED_EVENT.topic,
      source: 'notifications-test',
      occurredAt: notification.createdAt.toISOString(),
      payload: {
        notificationId: notification.id,
        userId: notification.userId,
        type: 'welcome',
        title: notification.title,
        body: notification.body,
        data: notification.data,
        createdAt: notification.createdAt.toISOString(),
      },
    });
  });

  it('never throws into the bus: a broker failure resolves false', async () => {
    const kafka = new FakeKafkaProducer({ source: 'notifications-test' });
    kafka.failNextWith(new Error('broker down'));

    await expect(
      new PublishNotificationCreatedHandler(kafka).execute(
        new PublishNotificationCreatedCommand(makeNotificationProps()),
      ),
    ).resolves.toBe(false);
    expect(kafka.records).toHaveLength(0);
  });
});

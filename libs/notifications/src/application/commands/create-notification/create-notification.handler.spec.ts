import { isUuidV7, uuidV7Timestamp } from '@app/common';
import { createMock } from '@app/testing';
import { type EventBus, EventPublisher, type IEvent } from '@nestjs/cqrs';
import { describe, expect, it } from 'vitest';
import { asClass, USER_ID } from '../../../../test/support/fixtures.js';
import { NotificationCreatedEvent } from '../../../domain/events/notification-created.event.js';
import { InvalidNotificationException } from '../../../domain/notification.errors.js';
import { deriveNotificationId } from '../../../domain/notification-id.js';
import type { NotificationsRepository } from '../../ports/notifications.repository.js';
import { CreateNotificationCommand } from './create-notification.command.js';
import { CreateNotificationHandler } from './create-notification.handler.js';

function setup() {
  const repository = createMock<NotificationsRepository>({ insert: async () => undefined });
  // AggregateRoot.commit() empties the array it published, so copy the events on the way out.
  const published: IEvent[] = [];
  const eventBus = createMock<EventBus>({
    publishAll: (events: IEvent[]) => {
      published.push(...events);
    },
  });
  const handler = new CreateNotificationHandler(repository, new EventPublisher(asClass(eventBus)));
  return { repository, eventBus, published, handler };
}

const input = {
  userId: USER_ID,
  type: 'system' as const,
  title: 'Maintenance tonight',
  body: '02:00–03:00 UTC',
};

describe('CreateNotificationHandler', () => {
  it('persists an unread notification with a fresh uuidv7, then publishes the event', async () => {
    const { repository, eventBus, published, handler } = setup();
    const before = Date.now();

    const result = await handler.execute(new CreateNotificationCommand(input));

    expect(isUuidV7(result.id)).toBe(true);
    expect(result).toMatchObject({ ...input, read: false, data: {} });
    expect(result.createdAt?.getTime()).toBeGreaterThanOrEqual(before);
    expect(repository.insert).toHaveBeenCalledWith(
      expect.objectContaining({ id: result.id, userId: USER_ID, read: false }),
    );
    expect(published).toHaveLength(1);
    expect(published[0]).toBeInstanceOf(NotificationCreatedEvent);
    expect((published[0] as NotificationCreatedEvent).notification.id).toBe(result.id);
    // Persist before publish: the push never announces a row that is not stored.
    expect(repository.insert.mock.invocationCallOrder[0]).toBeLessThan(
      eventBus.publishAll.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('derives a deterministic id and uses the fact time when an idempotency key is given', async () => {
    const { handler } = setup();
    const occurredAt = new Date('2026-01-01T00:00:00.000Z');
    const idempotency = { key: 'welcome:u1', occurredAt };

    const first = await handler.execute(new CreateNotificationCommand({ ...input, idempotency }));
    const second = await handler.execute(new CreateNotificationCommand({ ...input, idempotency }));

    expect(first.id).toBe(deriveNotificationId('welcome:u1', occurredAt));
    expect(second.id).toBe(first.id);
    expect(first.createdAt).toEqual(occurredAt);
    expect(uuidV7Timestamp(first.id)).toEqual(occurredAt);
  });

  it('does not publish when persistence fails', async () => {
    const { repository, eventBus, handler } = setup();
    repository.insert.mockRejectedValueOnce(new Error('NoHostAvailable'));

    await expect(handler.execute(new CreateNotificationCommand(input))).rejects.toThrow(
      'NoHostAvailable',
    );
    expect(eventBus.publishAll).not.toHaveBeenCalled();
  });

  it('rejects invalid notifications before touching the repository', async () => {
    const { repository, handler } = setup();
    await expect(
      handler.execute(new CreateNotificationCommand({ ...input, title: '' })),
    ).rejects.toBeInstanceOf(InvalidNotificationException);
    expect(repository.insert).not.toHaveBeenCalled();
  });
});

import { createMock } from '@app/testing';
import { describe, expect, it } from 'vitest';
import { USER_ID } from '../../../../test/support/fixtures.js';
import { NotificationNotFoundException } from '../../../domain/notification.errors.js';
import type { NotificationsRepository } from '../../ports/notifications.repository.js';
import { MarkNotificationReadCommand } from './mark-notification-read.command.js';
import { MarkNotificationReadHandler } from './mark-notification-read.handler.js';

const NOTIFICATION_ID = '01920000-0000-7000-8000-00000000abcd';

describe('MarkNotificationReadHandler', () => {
  it('marks the notification of the user read', async () => {
    const repository = createMock<NotificationsRepository>({ markRead: async () => true });
    await new MarkNotificationReadHandler(repository).execute(
      new MarkNotificationReadCommand(USER_ID, NOTIFICATION_ID),
    );
    expect(repository.markRead).toHaveBeenCalledWith(USER_ID, NOTIFICATION_ID);
  });

  it('answers NOTIFICATION_NOT_FOUND (404) when it is not in the user inbox', async () => {
    const repository = createMock<NotificationsRepository>({ markRead: async () => false });
    const promise = new MarkNotificationReadHandler(repository).execute(
      new MarkNotificationReadCommand(USER_ID, NOTIFICATION_ID),
    );
    await expect(promise).rejects.toBeInstanceOf(NotificationNotFoundException);
    await expect(promise).rejects.toMatchObject({
      code: 'NOTIFICATION_NOT_FOUND',
      httpStatus: 404,
      details: { entity: 'Notification', id: NOTIFICATION_ID },
    });
  });
});

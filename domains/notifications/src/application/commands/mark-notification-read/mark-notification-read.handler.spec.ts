import { createPrincipal, runWithPrincipal } from '@platform/common';
import { createMock } from '@platform/testing';
import { describe, expect, it } from 'vitest';
import {
  OTHER_TENANT_ID,
  OTHER_USER_ID,
  TENANT_ID,
  USER_ID,
} from '../../../../test/support/fixtures.js';
import { NotificationNotFoundException } from '../../../domain/notification.errors.js';
import type { NotificationsRepository } from '../../ports/notifications.repository.js';
import { MarkNotificationReadCommand } from './mark-notification-read.command.js';
import { MarkNotificationReadHandler } from './mark-notification-read.handler.js';

const NOTIFICATION_ID = '01920000-0000-7000-8000-00000000abcd';
const owner = createPrincipal({ userId: USER_ID, tenantId: TENANT_ID, roles: ['member'] });
const asOwner = <T>(fn: () => T): T => runWithPrincipal(owner, fn);

describe('MarkNotificationReadHandler', () => {
  it('marks the notification of the (tenant, user) inbox read', async () => {
    const repository = createMock<NotificationsRepository>({ markRead: async () => true });
    await asOwner(() =>
      new MarkNotificationReadHandler(repository).execute(
        new MarkNotificationReadCommand(TENANT_ID, USER_ID, NOTIFICATION_ID),
      ),
    );
    expect(repository.markRead).toHaveBeenCalledWith(TENANT_ID, USER_ID, NOTIFICATION_ID);
  });

  it('answers NOTIFICATION_NOT_FOUND (404) when it is not in the inbox', async () => {
    const repository = createMock<NotificationsRepository>({ markRead: async () => false });
    const promise = asOwner(() =>
      new MarkNotificationReadHandler(repository).execute(
        new MarkNotificationReadCommand(TENANT_ID, USER_ID, NOTIFICATION_ID),
      ),
    );
    await expect(promise).rejects.toBeInstanceOf(NotificationNotFoundException);
    await expect(promise).rejects.toMatchObject({
      code: 'NOTIFICATION_NOT_FOUND',
      httpStatus: 404,
      details: { entity: 'Notification', id: NOTIFICATION_ID },
    });
  });

  it.each([
    ['another tenant', OTHER_TENANT_ID, USER_ID],
    ['another user', TENANT_ID, OTHER_USER_ID],
  ])('403 TENANT_MISMATCH for %s, before any repository call', async (_, tenantId, userId) => {
    const repository = createMock<NotificationsRepository>({ markRead: async () => true });
    await expect(
      asOwner(() =>
        new MarkNotificationReadHandler(repository).execute(
          new MarkNotificationReadCommand(tenantId, userId, NOTIFICATION_ID),
        ),
      ),
    ).rejects.toMatchObject({ code: 'TENANT_MISMATCH', httpStatus: 403 });
    expect(repository.markRead).not.toHaveBeenCalled();
  });

  it('401 PRINCIPAL_MISSING without a principal, before any repository call', async () => {
    const repository = createMock<NotificationsRepository>({ markRead: async () => true });
    await expect(
      new MarkNotificationReadHandler(repository).execute(
        new MarkNotificationReadCommand(TENANT_ID, USER_ID, NOTIFICATION_ID),
      ),
    ).rejects.toMatchObject({ code: 'PRINCIPAL_MISSING' });
    expect(repository.markRead).not.toHaveBeenCalled();
  });
});

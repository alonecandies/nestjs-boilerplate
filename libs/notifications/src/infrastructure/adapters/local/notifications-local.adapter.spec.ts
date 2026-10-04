import { createMock } from '@app/testing';
import type { CommandBus, QueryBus } from '@nestjs/cqrs';
import { describe, expect, it } from 'vitest';
import { asClass, makeNotificationPage, USER_ID } from '../../../../test/support/fixtures.js';
import { MarkNotificationReadCommand } from '../../../application/commands/mark-notification-read/mark-notification-read.command.js';
import { ListNotificationsQuery } from '../../../application/queries/list-notifications/list-notifications.query.js';
import { NotificationsLocalAdapter } from './notifications-local.adapter.js';

const NOTIFICATION_ID = '01920000-0000-7000-8000-00000000abcd';

describe('NotificationsLocalAdapter', () => {
  it('lists through the query bus and returns the handler result unchanged', async () => {
    const page = makeNotificationPage();
    const queryBus = createMock<QueryBus>({ execute: async () => page });
    const adapter = new NotificationsLocalAdapter(
      asClass(queryBus),
      asClass(createMock<CommandBus>()),
    );

    await expect(adapter.list({ userId: USER_ID, limit: 5, pageState: 'ab' })).resolves.toBe(page);
    const [query] = queryBus.execute.mock.calls[0] ?? [];
    expect(query).toBeInstanceOf(ListNotificationsQuery);
    expect(query).toMatchObject({ userId: USER_ID, limit: 5, pageState: 'ab' });
  });

  it('marks read through the command bus and lets domain errors through', async () => {
    const commandBus = createMock<CommandBus>({ execute: async () => undefined });
    const adapter = new NotificationsLocalAdapter(
      asClass(createMock<QueryBus>()),
      asClass(commandBus),
    );

    await adapter.markRead({ userId: USER_ID, notificationId: NOTIFICATION_ID });
    const [command] = commandBus.execute.mock.calls[0] ?? [];
    expect(command).toBeInstanceOf(MarkNotificationReadCommand);
    expect(command).toMatchObject({ userId: USER_ID, notificationId: NOTIFICATION_ID });

    commandBus.execute.mockRejectedValueOnce(new Error('boom'));
    await expect(
      adapter.markRead({ userId: USER_ID, notificationId: NOTIFICATION_ID }),
    ).rejects.toThrow('boom');
  });
});

import { createMock } from '@app/testing';
import { describe, expect, it } from 'vitest';
import { makeNotificationProps, USER_ID } from '../../../../test/support/fixtures.js';
import {
  DEFAULT_NOTIFICATIONS_PAGE_SIZE,
  MAX_NOTIFICATIONS_PAGE_SIZE,
} from '../../../notifications.constants.js';
import { toNotificationContract } from '../../mappers/notification.mapper.js';
import type { NotificationsRepository } from '../../ports/notifications.repository.js';
import { ListNotificationsHandler } from './list-notifications.handler.js';
import { ListNotificationsQuery } from './list-notifications.query.js';

describe('ListNotificationsHandler', () => {
  it('returns one contract page with the next paging state', async () => {
    const item = makeNotificationProps();
    const repository = createMock<NotificationsRepository>({
      listByUser: async () => ({ items: [item], pageState: '0a0b' }),
    });

    const page = await new ListNotificationsHandler(repository).execute(
      new ListNotificationsQuery(USER_ID, 10, 'ff00'),
    );

    expect(repository.listByUser).toHaveBeenCalledWith(USER_ID, 10, 'ff00');
    expect(page).toEqual({ items: [toNotificationContract(item)], nextPageState: '0a0b' });
  });

  it('normalises the page size (proto default 0 → default, clamps the max) and blank states', async () => {
    const repository = createMock<NotificationsRepository>({
      listByUser: async () => ({ items: [], pageState: null }),
    });
    const handler = new ListNotificationsHandler(repository);

    await expect(handler.execute(new ListNotificationsQuery(USER_ID, 0, ''))).resolves.toEqual({
      items: [],
    });
    await handler.execute(new ListNotificationsQuery(USER_ID, 10_000));

    expect(repository.listByUser.mock.calls).toEqual([
      [USER_ID, DEFAULT_NOTIFICATIONS_PAGE_SIZE, undefined],
      [USER_ID, MAX_NOTIFICATIONS_PAGE_SIZE, undefined],
    ]);
  });
});

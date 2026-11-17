import { createPrincipal, runWithPrincipal } from '@platform/common';
import { createMock } from '@platform/testing';
import { describe, expect, it } from 'vitest';
import {
  makeNotificationProps,
  OTHER_TENANT_ID,
  OTHER_USER_ID,
  TENANT_ID,
  USER_ID,
} from '../../../../test/support/fixtures.js';
import {
  DEFAULT_NOTIFICATIONS_PAGE_SIZE,
  MAX_NOTIFICATIONS_PAGE_SIZE,
} from '../../../notifications.constants.js';
import { toNotificationContract } from '../../mappers/notification.mapper.js';
import type { NotificationsRepository } from '../../ports/notifications.repository.js';
import { ListNotificationsHandler } from './list-notifications.handler.js';
import { ListNotificationsQuery } from './list-notifications.query.js';

const owner = createPrincipal({ userId: USER_ID, tenantId: TENANT_ID, roles: ['member'] });
const asOwner = <T>(fn: () => T): T => runWithPrincipal(owner, fn);

describe('ListNotificationsHandler', () => {
  it('returns one contract page of the (tenant, user) inbox with the next paging state', async () => {
    const item = makeNotificationProps();
    const repository = createMock<NotificationsRepository>({
      listByUser: async () => ({ items: [item], pageState: '0a0b' }),
    });

    const page = await asOwner(() =>
      new ListNotificationsHandler(repository).execute(
        new ListNotificationsQuery(TENANT_ID, USER_ID, 10, 'ff00'),
      ),
    );

    expect(repository.listByUser).toHaveBeenCalledWith(TENANT_ID, USER_ID, 10, 'ff00');
    expect(page).toEqual({ items: [toNotificationContract(item)], nextPageState: '0a0b' });
  });

  it('normalises the page size (proto default 0 → default, clamps the max) and blank states', async () => {
    const repository = createMock<NotificationsRepository>({
      listByUser: async () => ({ items: [], pageState: null }),
    });
    const handler = new ListNotificationsHandler(repository);

    await expect(
      asOwner(() => handler.execute(new ListNotificationsQuery(TENANT_ID, USER_ID, 0, ''))),
    ).resolves.toEqual({ items: [] });
    await asOwner(() => handler.execute(new ListNotificationsQuery(TENANT_ID, USER_ID, 10_000)));

    expect(repository.listByUser.mock.calls).toEqual([
      [TENANT_ID, USER_ID, DEFAULT_NOTIFICATIONS_PAGE_SIZE, undefined],
      [TENANT_ID, USER_ID, MAX_NOTIFICATIONS_PAGE_SIZE, undefined],
    ]);
  });

  it.each([
    ['another tenant', OTHER_TENANT_ID, USER_ID],
    ['another user', TENANT_ID, OTHER_USER_ID],
  ])('403 TENANT_MISMATCH for %s, before any repository call', async (_, tenantId, userId) => {
    const repository = createMock<NotificationsRepository>({
      listByUser: async () => ({ items: [], pageState: null }),
    });
    await expect(
      asOwner(() =>
        new ListNotificationsHandler(repository).execute(
          new ListNotificationsQuery(tenantId, userId, 10),
        ),
      ),
    ).rejects.toMatchObject({ code: 'TENANT_MISMATCH', httpStatus: 403 });
    expect(repository.listByUser).not.toHaveBeenCalled();
  });

  it('401 PRINCIPAL_MISSING without a principal, before any repository call', async () => {
    const repository = createMock<NotificationsRepository>({
      listByUser: async () => ({ items: [], pageState: null }),
    });
    await expect(
      new ListNotificationsHandler(repository).execute(
        new ListNotificationsQuery(TENANT_ID, USER_ID, 10),
      ),
    ).rejects.toMatchObject({ code: 'PRINCIPAL_MISSING' });
    expect(repository.listByUser).not.toHaveBeenCalled();
  });
});

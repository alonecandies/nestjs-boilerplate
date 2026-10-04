import type { CassandraClient } from '@app/cassandra';
import { uuidV7Timestamp } from '@app/common';
import { createMock } from '@app/testing';
import cassandra from 'cassandra-driver';
import { describe, expect, it } from 'vitest';
import { asClass, makeNotificationProps, USER_ID } from '../../../test/support/fixtures.js';
import {
  CassandraNotificationsRepository,
  NOTIFICATIONS_CQL,
  toNotificationProps,
} from './cassandra-notifications.repository.js';

const { Uuid } = cassandra.types;

function row(values: Record<string, unknown>): cassandra.types.Row {
  return { get: (column: string) => values[column] } as unknown as cassandra.types.Row;
}

function resultSet(
  rows: cassandra.types.Row[],
  extra: { pageState?: string; applied?: boolean } = {},
) {
  return {
    rows,
    pageState: extra.pageState,
    wasApplied: () => extra.applied ?? true,
  } as unknown as cassandra.types.ResultSet;
}

const stored = makeNotificationProps({ type: 'payment_receipt', read: true });
const storedRow = row({
  user_id: Uuid.fromString(stored.userId),
  notification_id: Uuid.fromString(stored.id),
  type: stored.type,
  title: stored.title,
  body: stored.body,
  data: stored.data,
  read: true,
  created_at: stored.createdAt,
});

function setup(rs: cassandra.types.ResultSet = resultSet([])) {
  const client = createMock<CassandraClient>({ execute: async () => rs });
  return { client, repository: new CassandraNotificationsRepository(asClass(client)) };
}

describe('CassandraNotificationsRepository', () => {
  it('inserts with a prepared, idempotent statement and never writes `read`', async () => {
    const { client, repository } = setup();
    const notification = makeNotificationProps();

    await repository.insert(notification);

    expect(NOTIFICATIONS_CQL.insert).not.toMatch(/\bread\b/);
    expect(client.execute).toHaveBeenCalledWith(
      NOTIFICATIONS_CQL.insert,
      [
        notification.userId,
        notification.id,
        notification.type,
        notification.title,
        notification.body,
        notification.data,
        notification.createdAt,
      ],
      { prepare: true, isIdempotent: true },
    );
  });

  it('lists one partition page with the driver page state (single-partition query)', async () => {
    const { client, repository } = setup(resultSet([storedRow], { pageState: 'cafe' }));

    const slice = await repository.listByUser(USER_ID, 20, 'beef');

    expect(slice).toEqual({ items: [stored], pageState: 'cafe' });
    expect(NOTIFICATIONS_CQL.listByUser).toMatch(/WHERE user_id = \?$/);
    expect(client.execute).toHaveBeenCalledWith(
      NOTIFICATIONS_CQL.listByUser,
      [USER_ID],
      expect.objectContaining({ prepare: true, fetchSize: 20, pageState: 'beef' }),
    );
  });

  it('rejects a forged page state before querying (422 INVALID_PAGE_STATE)', async () => {
    const { client, repository } = setup();
    await expect(repository.listByUser(USER_ID, 20, 'not-hex')).rejects.toMatchObject({
      code: 'INVALID_PAGE_STATE',
    });
    expect(client.execute).not.toHaveBeenCalled();
  });

  it('reads the newest notifications with a bound LIMIT', async () => {
    const { client, repository } = setup(resultSet([storedRow]));
    await expect(repository.findRecentByUser(USER_ID, 50)).resolves.toEqual([stored]);
    expect(client.execute).toHaveBeenCalledWith(NOTIFICATIONS_CQL.recentByUser, [USER_ID, 50], {
      prepare: true,
      isIdempotent: true,
    });
  });

  it('marks read with a conditional update and reports whether the row existed', async () => {
    const found = setup(resultSet([], { applied: true }));
    await expect(found.repository.markRead(USER_ID, stored.id)).resolves.toBe(true);
    expect(found.client.execute).toHaveBeenCalledWith(
      NOTIFICATIONS_CQL.markRead,
      [USER_ID, stored.id],
      { prepare: true },
    );
    expect(NOTIFICATIONS_CQL.markRead).toMatch(/IF EXISTS$/);

    const missing = setup(resultSet([], { applied: false }));
    await expect(missing.repository.markRead(USER_ID, stored.id)).resolves.toBe(false);
  });
});

describe('toNotificationProps', () => {
  it('maps driver cells and tolerates nulls (unread, empty map, unknown type)', () => {
    const id = makeNotificationProps().id;
    const props = toNotificationProps(
      row({
        user_id: Uuid.fromString(USER_ID),
        notification_id: Uuid.fromString(id),
        type: 'from-the-future',
        title: 'T',
        body: null,
        data: null,
        read: null,
        created_at: null,
      }),
    );
    expect(props).toMatchObject({
      id,
      userId: USER_ID,
      type: 'system',
      body: '',
      data: {},
      read: false,
    });
    // A missing timestamp falls back to the uuidv7 time.
    expect(props.createdAt).toEqual(uuidV7Timestamp(id));
  });
});

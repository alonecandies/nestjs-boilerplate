import type { CassandraClient } from '@app/cassandra';
import { uuidV7Timestamp } from '@app/common';
import { createMock } from '@app/testing';
import cassandra from 'cassandra-driver';
import { v4, v7 } from 'uuid';
import { describe, expect, it } from 'vitest';
import { asClass, makeNotificationProps, USER_ID } from '../../../test/support/fixtures.js';
import {
  CassandraNotificationsRepository,
  isGhostRow,
  NOTIFICATIONS_CQL,
  remainingTtlSec,
  toNotificationProps,
} from './cassandra-notifications.repository.js';
import { NOTIFICATIONS_TTL_SEC } from './notifications-cassandra.migrations.js';

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
const DAY_MS = 86_400_000;

// What an UPDATE leaves behind once the inserted cells expired: keys + `read`, nothing else.
const ghostRow = row({
  user_id: Uuid.fromString(USER_ID),
  notification_id: Uuid.fromString(v7()),
  type: null,
  title: null,
  body: null,
  data: null,
  read: true,
  created_at: null,
});

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
      [expect.any(Number), USER_ID, stored.id],
      { prepare: true },
    );
    expect(NOTIFICATIONS_CQL.markRead).toMatch(/IF EXISTS$/);

    const missing = setup(resultSet([], { applied: false }));
    await expect(missing.repository.markRead(USER_ID, stored.id)).resolves.toBe(false);
  });

  it('writes `read` with the row’s remaining lifetime, never a fresh 90-day TTL', async () => {
    expect(NOTIFICATIONS_CQL.markRead).toMatch(/^UPDATE notifications_by_user USING TTL \? SET /);
    const tenDaysOld = v7({ msecs: Date.now() - 10 * DAY_MS });
    const { client, repository } = setup(resultSet([], { applied: true }));

    await repository.markRead(USER_ID, tenDaysOld);

    const params: unknown = client.execute.mock.calls[0]?.[1];
    const ttl = Array.isArray(params) ? Number(params[0]) : Number.NaN;
    expect(ttl).toBeLessThanOrEqual(NOTIFICATIONS_TTL_SEC - 10 * 86_400);
    expect(ttl).toBeGreaterThan(NOTIFICATIONS_TTL_SEC - 10 * 86_400 - 5);
  });

  it('does not touch rows past their 90 days, nor ids that cannot be in the inbox', async () => {
    const { client, repository } = setup(resultSet([], { applied: true }));

    await expect(
      repository.markRead(USER_ID, v7({ msecs: Date.now() - 91 * DAY_MS })),
    ).resolves.toBe(false);
    await expect(repository.markRead(USER_ID, v4())).resolves.toBe(false);
    expect(client.execute).not.toHaveBeenCalled();
  });

  it('skips ghost rows (only `read` left) in listings and the digest scan', async () => {
    const list = setup(resultSet([ghostRow, storedRow], { pageState: 'cafe' }));
    await expect(list.repository.listByUser(USER_ID, 20)).resolves.toEqual({
      items: [stored],
      pageState: 'cafe',
    });

    const recent = setup(resultSet([storedRow, ghostRow]));
    await expect(recent.repository.findRecentByUser(USER_ID, 50)).resolves.toEqual([stored]);
  });
});

describe('remainingTtlSec', () => {
  const now = Date.parse('2026-10-01T00:00:00Z');

  it('is the 90-day lifetime minus the age embedded in the uuidv7', () => {
    expect(remainingTtlSec(v7({ msecs: now }), now)).toBe(NOTIFICATIONS_TTL_SEC);
    expect(remainingTtlSec(v7({ msecs: now - 30 * DAY_MS }), now)).toBe(
      NOTIFICATIONS_TTL_SEC - 30 * 86_400,
    );
    expect(remainingTtlSec(v7({ msecs: now - 90 * DAY_MS }), now)).toBe(0);
  });

  it('caps ids from the future (clock skew) and rejects non-v7 ids', () => {
    expect(remainingTtlSec(v7({ msecs: now + 60_000 }), now)).toBe(NOTIFICATIONS_TTL_SEC);
    expect(remainingTtlSec(v4(), now)).toBe(0);
  });
});

describe('isGhostRow', () => {
  it('is true only without both `type` and `created_at`', () => {
    expect(isGhostRow(ghostRow)).toBe(true);
    expect(isGhostRow(storedRow)).toBe(false);
    expect(isGhostRow(row({ type: 'system', created_at: null }))).toBe(false);
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

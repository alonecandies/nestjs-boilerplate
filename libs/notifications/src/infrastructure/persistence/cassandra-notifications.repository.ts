import { type CassandraClient, executePage, InjectCassandra } from '@app/cassandra';
import { isUuidV7, uuidV7Timestamp } from '@app/common';
import { Injectable } from '@nestjs/common';
import type cassandra from 'cassandra-driver';
import { isNil } from 'lodash-es';
import {
  NotificationsRepository,
  type NotificationsSlice,
} from '../../application/ports/notifications.repository.js';
import { isNotificationKind, type NotificationProps } from '../../domain/notification.types.js';
import {
  booleanCell,
  textCell,
  textMapCell,
  timestampCell,
  uuidCell,
} from './cassandra-row.util.js';
import { NOTIFICATIONS_TTL_SEC } from './notifications-cassandra.migrations.js';

const COLUMNS = 'user_id, notification_id, type, title, body, data, read, created_at';

/**
 * Every statement is a constant string executed with `prepare: true`: the driver prepares it
 * once per node and caches it (bind + token-aware routing afterwards). Queries always hit ONE
 * partition (`user_id = ?`) — no ALLOW FILTERING, no scatter-gather.
 */
export const NOTIFICATIONS_CQL = {
  // `read` is deliberately not written: see NotificationsRepository.insert.
  insert:
    'INSERT INTO notifications_by_user (user_id, notification_id, type, title, body, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  listByUser: `SELECT ${COLUMNS} FROM notifications_by_user WHERE user_id = ?`,
  recentByUser: `SELECT ${COLUMNS} FROM notifications_by_user WHERE user_id = ? LIMIT ?`,
  // LWT (Paxos): a plain UPDATE would upsert a ghost row holding only `read` for unknown ids.
  // USING TTL: the table's default TTL applies to UPDATEs too, so without it the `read` cell would
  // get a fresh 90 days and keep a "ghost" row (only `read`, no row marker) alive after the
  // inserted cells expired. The bound TTL is the row's remaining lifetime (`remainingTtlSec`).
  markRead:
    'UPDATE notifications_by_user USING TTL ? SET read = true WHERE user_id = ? AND notification_id = ? IF EXISTS',
} as const;

/**
 * Seconds an inbox row has left, from the creation time embedded in its uuidv7 id, capped at
 * `NOTIFICATIONS_TTL_SEC` (clock skew). `<= 0` means the row has expired or is about to; a non-v7
 * id cannot be in the inbox at all (every id is a uuidv7) and also yields 0. For derived ids the
 * time is the fact's time, which precedes the insert, so the estimate errs on the short side: the
 * `read` cell may expire slightly before the row (by the event's processing delay), never after.
 */
export function remainingTtlSec(notificationId: string, nowMs: number = Date.now()): number {
  if (!isUuidV7(notificationId)) return 0;
  const ageSec = Math.floor((nowMs - uuidV7Timestamp(notificationId).getTime()) / 1_000);
  return Math.min(NOTIFICATIONS_TTL_SEC - ageSec, NOTIFICATIONS_TTL_SEC);
}

/**
 * A row whose inserted cells (and row marker) expired while a later-written cell survived: no
 * `type`, no `created_at`. Inserts always write both, so such a row is never a real notification.
 * Rows written by an UPDATE without `USING TTL` (before it was added) can still be around.
 */
export function isGhostRow(row: cassandra.types.Row): boolean {
  return isNil(row.get('type')) && isNil(row.get('created_at'));
}

/** `toNotificationProps`, or `undefined` for a ghost row (`isGhostRow`). */
export function toLiveNotificationProps(row: cassandra.types.Row): NotificationProps | undefined {
  return isGhostRow(row) ? undefined : toNotificationProps(row);
}

const isDefined = <T>(value: T | undefined): value is T => value !== undefined;

export function toNotificationProps(row: cassandra.types.Row): NotificationProps {
  const id = uuidCell(row, 'notification_id');
  const type = textCell(row, 'type');
  return {
    id,
    userId: uuidCell(row, 'user_id'),
    type: isNotificationKind(type) ? type : 'system',
    title: textCell(row, 'title'),
    body: textCell(row, 'body'),
    data: textMapCell(row, 'data'),
    read: booleanCell(row, 'read'),
    // The uuidv7 id embeds its creation time: a sane fallback for a missing cell.
    createdAt: timestampCell(row, 'created_at', () => uuidV7Timestamp(id)),
  };
}

@Injectable()
export class CassandraNotificationsRepository implements NotificationsRepository {
  constructor(@InjectCassandra() private readonly client: CassandraClient) {}

  async insert(notification: Readonly<NotificationProps>): Promise<void> {
    await this.client.execute(
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
      // Same primary key + same values: safe to retry / speculatively execute.
      { prepare: true, isIdempotent: true },
    );
  }

  async listByUser(userId: string, limit: number, pageState?: string): Promise<NotificationsSlice> {
    const page = await executePage(this.client, NOTIFICATIONS_CQL.listByUser, [userId], {
      fetchSize: limit,
      pageState: pageState ?? null,
      mapRow: toLiveNotificationProps,
      queryOptions: { isIdempotent: true },
    });
    return { items: page.items.filter(isDefined), pageState: page.pageState };
  }

  async findRecentByUser(userId: string, limit: number): Promise<NotificationProps[]> {
    const rs = await this.client.execute(NOTIFICATIONS_CQL.recentByUser, [userId, limit], {
      prepare: true,
      isIdempotent: true,
    });
    return rs.rows.map(toLiveNotificationProps).filter(isDefined);
  }

  async markRead(userId: string, notificationId: string): Promise<boolean> {
    const ttlSec = remainingTtlSec(notificationId);
    // Past its 90 days the notification is gone from the inbox's contract (or is about to be).
    if (ttlSec <= 0) return false;
    const rs = await this.client.execute(
      NOTIFICATIONS_CQL.markRead,
      [ttlSec, userId, notificationId],
      { prepare: true },
    );
    return rs.wasApplied();
  }
}

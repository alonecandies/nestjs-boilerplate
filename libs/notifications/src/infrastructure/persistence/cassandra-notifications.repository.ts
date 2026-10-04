import { type CassandraClient, executePage, InjectCassandra } from '@app/cassandra';
import { uuidV7Timestamp } from '@app/common';
import { Injectable } from '@nestjs/common';
import type cassandra from 'cassandra-driver';
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
  markRead:
    'UPDATE notifications_by_user SET read = true WHERE user_id = ? AND notification_id = ? IF EXISTS',
} as const;

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

  listByUser(userId: string, limit: number, pageState?: string): Promise<NotificationsSlice> {
    return executePage(this.client, NOTIFICATIONS_CQL.listByUser, [userId], {
      fetchSize: limit,
      pageState: pageState ?? null,
      mapRow: toNotificationProps,
      queryOptions: { isIdempotent: true },
    });
  }

  async findRecentByUser(userId: string, limit: number): Promise<NotificationProps[]> {
    const rs = await this.client.execute(NOTIFICATIONS_CQL.recentByUser, [userId, limit], {
      prepare: true,
      isIdempotent: true,
    });
    return rs.rows.map(toNotificationProps);
  }

  async markRead(userId: string, notificationId: string): Promise<boolean> {
    const rs = await this.client.execute(NOTIFICATIONS_CQL.markRead, [userId, notificationId], {
      prepare: true,
    });
    return rs.wasApplied();
  }
}

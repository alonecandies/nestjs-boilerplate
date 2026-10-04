import { type CassandraClient, executePage, InjectCassandra } from '@app/cassandra';
import { Injectable } from '@nestjs/common';
import type cassandra from 'cassandra-driver';
import {
  type NotificationRecipient,
  NotificationRecipientsRepository,
  type NotificationRecipientsSlice,
} from '../../application/ports/notification-recipients.repository.js';
import { textCell, timestampCell, uuidCell } from './cassandra-row.util.js';

const COLUMNS = 'user_id, email, display_name, updated_at';

export const RECIPIENTS_CQL = {
  upsert:
    'INSERT INTO notification_recipients (user_id, email, display_name, updated_at) VALUES (?, ?, ?, ?)',
  findById: `SELECT ${COLUMNS} FROM notification_recipients WHERE user_id = ?`,
  // Full-table scan in token order, always paged and capped by the caller (batch jobs only).
  scan: `SELECT ${COLUMNS} FROM notification_recipients`,
} as const;

export function toNotificationRecipient(row: cassandra.types.Row): NotificationRecipient {
  return {
    userId: uuidCell(row, 'user_id'),
    email: textCell(row, 'email'),
    displayName: textCell(row, 'display_name'),
    updatedAt: timestampCell(row, 'updated_at', () => new Date(0)),
  };
}

@Injectable()
export class CassandraNotificationRecipientsRepository implements NotificationRecipientsRepository {
  constructor(@InjectCassandra() private readonly client: CassandraClient) {}

  async upsert(recipient: NotificationRecipient): Promise<void> {
    await this.client.execute(
      RECIPIENTS_CQL.upsert,
      [recipient.userId, recipient.email, recipient.displayName, recipient.updatedAt],
      { prepare: true, isIdempotent: true },
    );
  }

  async findById(userId: string): Promise<NotificationRecipient | null> {
    const rs = await this.client.execute(RECIPIENTS_CQL.findById, [userId], {
      prepare: true,
      isIdempotent: true,
    });
    // `first()` is typed `Row` but returns null on an empty result; index access is honest.
    const row = rs.rows[0];
    return row ? toNotificationRecipient(row) : null;
  }

  scan(limit: number, pageState?: string): Promise<NotificationRecipientsSlice> {
    return executePage(this.client, RECIPIENTS_CQL.scan, [], {
      fetchSize: limit,
      pageState: pageState ?? null,
      mapRow: toNotificationRecipient,
      queryOptions: { isIdempotent: true },
    });
  }
}

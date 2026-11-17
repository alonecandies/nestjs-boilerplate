import { Injectable } from '@nestjs/common';
import { type CassandraClient, executePage, InjectCassandra } from '@platform/cassandra';
import type cassandra from 'cassandra-driver';
import {
  type NotificationRecipient,
  NotificationRecipientsRepository,
  type NotificationRecipientsSlice,
} from '../../application/ports/notification-recipients.repository.js';
import { textCell, timestampCell, uuidCell } from './cassandra-row.util.js';

const TABLE = 'notification_recipients_by_tenant';
const COLUMNS = 'tenant_id, user_id, email, display_name, updated_at';

/**
 * Every statement binds both partition-key columns, `tenant_id` then `user_id` (the scan aside).
 * Writes carry `USING TIMESTAMP` = the membership event's time: Cassandra keeps the write with the
 * highest timestamp and a delete shadows every write stamped at or before it, so a replayed or
 * reordered `membership-created` cannot resurrect a removed member.
 */
export const RECIPIENTS_CQL = {
  upsert: `INSERT INTO ${TABLE} (${COLUMNS}) VALUES (?, ?, ?, ?, ?) USING TIMESTAMP ?`,
  find: `SELECT ${COLUMNS} FROM ${TABLE} WHERE tenant_id = ? AND user_id = ?`,
  remove: `DELETE FROM ${TABLE} USING TIMESTAMP ? WHERE tenant_id = ? AND user_id = ?`,
  // Full-table scan in token order, always paged and capped by the caller (batch jobs only).
  scan: `SELECT ${COLUMNS} FROM ${TABLE}`,
} as const;

/**
 * A Cassandra write timestamp: microseconds since the epoch, as a BigInt (the client encodes
 * `bigint` with `useBigIntAsLong`).
 */
export const writeTimestamp = (date: Date): bigint => BigInt(date.getTime()) * 1000n;

export function toNotificationRecipient(row: cassandra.types.Row): NotificationRecipient {
  return {
    tenantId: uuidCell(row, 'tenant_id'),
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
    const { tenantId, userId, email, displayName, updatedAt } = recipient;
    await this.client.execute(
      RECIPIENTS_CQL.upsert,
      [tenantId, userId, email, displayName, updatedAt, writeTimestamp(updatedAt)],
      { prepare: true, isIdempotent: true },
    );
  }

  async find(tenantId: string, userId: string): Promise<NotificationRecipient | null> {
    const rs = await this.client.execute(RECIPIENTS_CQL.find, [tenantId, userId], {
      prepare: true,
      isIdempotent: true,
    });
    // `first()` is typed `Row` but returns null on an empty result; index access is honest.
    const row = rs.rows[0];
    return row ? toNotificationRecipient(row) : null;
  }

  async remove(tenantId: string, userId: string, removedAt: Date = new Date()): Promise<void> {
    await this.client.execute(
      RECIPIENTS_CQL.remove,
      [writeTimestamp(removedAt), tenantId, userId],
      { prepare: true, isIdempotent: true },
    );
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

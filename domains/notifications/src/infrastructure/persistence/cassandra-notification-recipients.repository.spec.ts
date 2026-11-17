import type { CassandraClient } from '@platform/cassandra';
import { createMock } from '@platform/testing';
import cassandra from 'cassandra-driver';
import { describe, expect, it } from 'vitest';
import { asClass, TENANT_ID, USER_ID } from '../../../test/support/fixtures.js';
import {
  CassandraNotificationRecipientsRepository,
  RECIPIENTS_CQL,
} from './cassandra-notification-recipients.repository.js';

const updatedAt = new Date('2026-09-29T07:00:00.123Z');
/** Cassandra write timestamps are microseconds since the epoch, bound as a bigint. */
const updatedAtMicros = 1_790_665_200_123_000n;
const recipient = {
  tenantId: TENANT_ID,
  userId: USER_ID,
  email: 'ada@example.com',
  displayName: 'Ada',
  updatedAt,
};
const recipientRow = {
  get: (column: string) =>
    ({
      tenant_id: cassandra.types.Uuid.fromString(TENANT_ID),
      user_id: cassandra.types.Uuid.fromString(USER_ID),
      email: recipient.email,
      display_name: recipient.displayName,
      updated_at: updatedAt,
    })[column],
} as unknown as cassandra.types.Row;

function setup(rows: cassandra.types.Row[], pageState?: string) {
  const client = createMock<CassandraClient>({
    execute: async () => ({ rows, pageState }) as unknown as cassandra.types.ResultSet,
  });
  return { client, repository: new CassandraNotificationRecipientsRepository(asClass(client)) };
}

describe('CassandraNotificationRecipientsRepository', () => {
  it('addresses notification_recipients_by_tenant in every statement', () => {
    for (const cql of Object.values(RECIPIENTS_CQL)) {
      expect(cql).toContain('notification_recipients_by_tenant');
      expect(cql).not.toMatch(/notification_recipients(?!_by_tenant)/);
      expect(cql).not.toContain('ALLOW FILTERING');
    }
  });

  it('has the exact statements, both partition-key columns bound in order', () => {
    expect(RECIPIENTS_CQL).toEqual({
      upsert:
        'INSERT INTO notification_recipients_by_tenant (tenant_id, user_id, email, display_name, updated_at) VALUES (?, ?, ?, ?, ?) USING TIMESTAMP ?',
      find: 'SELECT tenant_id, user_id, email, display_name, updated_at FROM notification_recipients_by_tenant WHERE tenant_id = ? AND user_id = ?',
      remove:
        'DELETE FROM notification_recipients_by_tenant USING TIMESTAMP ? WHERE tenant_id = ? AND user_id = ?',
      scan: 'SELECT tenant_id, user_id, email, display_name, updated_at FROM notification_recipients_by_tenant',
    });
  });

  it('upserts idempotently, tenant then user, stamped with updatedAt in microseconds', async () => {
    const { client, repository } = setup([]);
    await repository.upsert(recipient);
    expect(client.execute).toHaveBeenCalledWith(
      RECIPIENTS_CQL.upsert,
      [TENANT_ID, USER_ID, 'ada@example.com', 'Ada', updatedAt, updatedAtMicros],
      { prepare: true, isIdempotent: true },
    );
  });

  it('finds by (tenant, user), or null when the pair has no row', async () => {
    const found = setup([recipientRow]);
    await expect(found.repository.find(TENANT_ID, USER_ID)).resolves.toEqual(recipient);
    expect(found.client.execute).toHaveBeenCalledWith(RECIPIENTS_CQL.find, [TENANT_ID, USER_ID], {
      prepare: true,
      isIdempotent: true,
    });
    await expect(setup([]).repository.find(TENANT_ID, USER_ID)).resolves.toBeNull();
  });

  it('removes (tenant, user) idempotently, stamped with removedAt in microseconds', async () => {
    const { client, repository } = setup([]);
    await repository.remove(TENANT_ID, USER_ID, updatedAt);
    expect(client.execute).toHaveBeenCalledWith(
      RECIPIENTS_CQL.remove,
      [updatedAtMicros, TENANT_ID, USER_ID],
      { prepare: true, isIdempotent: true },
    );
  });

  it('removes stamped with the current time when no removal time is given', async () => {
    const { client, repository } = setup([]);
    const before = BigInt(Date.now()) * 1000n;
    await repository.remove(TENANT_ID, USER_ID);
    const after = BigInt(Date.now()) * 1000n;
    const [, params] = client.execute.mock.calls[0] ?? [];
    const [stamp, tenantId, userId] = params as unknown as [bigint, string, string];
    expect([tenantId, userId]).toEqual([TENANT_ID, USER_ID]);
    expect(stamp >= before && stamp <= after).toBe(true);
  });

  it('scans in pages, one item per (tenant, user) with its tenant', async () => {
    const { client, repository } = setup([recipientRow], 'aa');
    await expect(repository.scan(200, 'bb')).resolves.toEqual({
      items: [recipient],
      pageState: 'aa',
    });
    expect(client.execute).toHaveBeenCalledWith(
      RECIPIENTS_CQL.scan,
      [],
      expect.objectContaining({ fetchSize: 200, pageState: 'bb', prepare: true }),
    );
  });
});

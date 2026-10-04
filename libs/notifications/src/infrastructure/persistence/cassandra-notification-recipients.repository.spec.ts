import type { CassandraClient } from '@app/cassandra';
import { createMock } from '@app/testing';
import cassandra from 'cassandra-driver';
import { describe, expect, it } from 'vitest';
import { asClass, USER_ID } from '../../../test/support/fixtures.js';
import {
  CassandraNotificationRecipientsRepository,
  RECIPIENTS_CQL,
} from './cassandra-notification-recipients.repository.js';

const updatedAt = new Date('2026-09-29T07:00:00.000Z');
const recipient = { userId: USER_ID, email: 'ada@example.com', displayName: 'Ada', updatedAt };
const recipientRow = {
  get: (column: string) =>
    ({
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
  it('upserts idempotently', async () => {
    const { client, repository } = setup([]);
    await repository.upsert(recipient);
    expect(client.execute).toHaveBeenCalledWith(
      RECIPIENTS_CQL.upsert,
      [USER_ID, 'ada@example.com', 'Ada', updatedAt],
      { prepare: true, isIdempotent: true },
    );
  });

  it('finds by id, or null for an unknown user', async () => {
    await expect(setup([recipientRow]).repository.findById(USER_ID)).resolves.toEqual(recipient);
    await expect(setup([]).repository.findById(USER_ID)).resolves.toBeNull();
  });

  it('scans in pages', async () => {
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

import { buildClientOptions, type CassandraClient, CqlMigrator } from '@platform/cassandra';
import { generateId } from '@platform/common';
import { cassandraConfig } from '@platform/config';
import { startTestCassandra, type TestCassandra } from '@platform/testing/cassandra';
import cassandra from 'cassandra-driver';
import { sortBy } from 'lodash-es';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NotificationRecipient } from '../src/application/ports/notification-recipients.repository.js';
import { CassandraNotificationRecipientsRepository } from '../src/infrastructure/persistence/cassandra-notification-recipients.repository.js';
import { notificationsCassandraMigrations } from '../src/infrastructure/persistence/notifications-cassandra.migrations.js';

/*
 * The recipients projection against a real Cassandra: the context's migrations and the production
 * repository on a client built with the production driver options (BigInt timestamps included).
 * Opt-in (needs Docker):
 *   INTEGRATION=1 bunx vitest run --project notifications:int test/recipients
 */

const at = (iso: string): Date => new Date(iso);

const recipient = (
  tenantId: string,
  userId: string,
  email: string,
  updatedAt = at('2026-09-29T07:00:00.000Z'),
): NotificationRecipient => ({ tenantId, userId, email, displayName: 'Ada', updatedAt });

describe.skipIf(process.env['INTEGRATION'] !== '1')('recipients projection (Cassandra)', () => {
  let node: TestCassandra | undefined;
  let client: CassandraClient | undefined;
  let recipients: CassandraNotificationRecipientsRepository;

  beforeAll(async () => {
    node = await startTestCassandra();
    const cfg = cassandraConfig.parse({
      CASSANDRA_CONTACT_POINTS: node.contactPoints.join(','),
      CASSANDRA_LOCAL_DC: node.localDataCenter,
      CASSANDRA_KEYSPACE: node.keyspace,
    });
    client = new cassandra.Client(
      buildClientOptions(cfg, { applicationName: 'notifications-int', keyspace: node.keyspace }),
    );
    await client.connect();
    await new CqlMigrator(client, {
      keyspace: node.keyspace,
      sources: [notificationsCassandraMigrations],
    }).run();
    recipients = new CassandraNotificationRecipientsRepository(client);
  });

  afterAll(async () => {
    await client?.shutdown();
    await node?.stop();
  });

  it('keeps one row per (tenant, user): find returns each pair its own address', async () => {
    const [a, b, u] = [generateId(), generateId(), generateId()];
    await recipients.upsert(recipient(a, u, 'u@a.example'));
    await recipients.upsert(recipient(b, u, 'u@b.example'));

    await expect(recipients.find(a, u)).resolves.toMatchObject({
      tenantId: a,
      userId: u,
      email: 'u@a.example',
    });
    await expect(recipients.find(b, u)).resolves.toMatchObject({
      tenantId: b,
      userId: u,
      email: 'u@b.example',
    });
    await expect(recipients.find(generateId(), u)).resolves.toBeNull();
  });

  it('remove(A, U) leaves (B, U)', async () => {
    const [a, b, u] = [generateId(), generateId(), generateId()];
    await recipients.upsert(recipient(a, u, 'u@a.example'));
    await recipients.upsert(recipient(b, u, 'u@b.example'));

    await recipients.remove(a, u, at('2026-09-29T08:00:00.000Z'));

    await expect(recipients.find(a, u)).resolves.toBeNull();
    await expect(recipients.find(b, u)).resolves.toMatchObject({ email: 'u@b.example' });
  });

  it('an upsert stamped before a later-stamped remove stays removed; one stamped after returns', async () => {
    const [a, u] = [generateId(), generateId()];
    await recipients.upsert(recipient(a, u, 'u@a.example', at('2026-09-29T07:00:00.000Z')));
    await recipients.remove(a, u, at('2026-09-29T08:00:00.000Z'));

    // A replayed (or reordered) created event, older than the removal.
    await recipients.upsert(recipient(a, u, 'u@a.example', at('2026-09-29T07:30:00.000Z')));
    await expect(recipients.find(a, u)).resolves.toBeNull();

    // A new membership after the removal.
    await recipients.upsert(recipient(a, u, 'again@a.example', at('2026-09-29T09:00:00.000Z')));
    await expect(recipients.find(a, u)).resolves.toMatchObject({ email: 'again@a.example' });
  });

  it('scan returns every (tenant, user) pair once, with its tenant, across pages', async () => {
    const [a, b, c, u, v] = [generateId(), generateId(), generateId(), generateId(), generateId()];
    const written = [
      recipient(a, u, 'u@a.example'),
      recipient(b, u, 'u@b.example'),
      recipient(c, v, 'v@c.example'),
    ];
    for (const row of written) await recipients.upsert(row);

    const seen: NotificationRecipient[] = [];
    let pageState: string | undefined;
    for (let pages = 0; pages < 100; pages++) {
      const page = await recipients.scan(2, pageState);
      seen.push(...page.items);
      if (!page.pageState || page.items.length === 0) break;
      pageState = page.pageState;
    }

    const keys = seen.map((r) => `${r.tenantId}/${r.userId}`);
    expect(new Set(keys).size).toBe(keys.length);
    const mine = seen.filter((r) => [a, b, c].includes(r.tenantId));
    expect(sortBy(mine, 'email')).toEqual(sortBy(written, 'email'));
  });
});
